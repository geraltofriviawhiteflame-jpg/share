#!/usr/bin/env python3
"""Apply and inspect the project's raw SQLite migrations.

This dependency-free runner exists so the schema can be exercised before the
web application and ORM are introduced. It records a SHA-256 checksum for each
migration and refuses to continue if an already-applied file changes.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE = PROJECT_ROOT / "data" / "share.db"
DEFAULT_MIGRATIONS = PROJECT_ROOT / "db" / "migrations"
MIGRATION_PATTERN = re.compile(r"^(?P<version>\d+)_(?P<name>[a-z0-9_]+)\.sql$")


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    path: Path
    checksum: str
    sql: str


def sql_literal(value: str) -> str:
    """Return a safely quoted SQLite string literal."""

    return "'" + value.replace("'", "''") + "'"


def discover_migrations(directory: Path) -> list[Migration]:
    if not directory.is_dir():
        raise RuntimeError(f"Migration directory does not exist: {directory}")

    migrations: list[Migration] = []
    seen_versions: set[int] = set()

    for path in sorted(directory.glob("*.sql")):
        match = MIGRATION_PATTERN.fullmatch(path.name)
        if match is None:
            raise RuntimeError(
                f"Invalid migration filename {path.name!r}; expected "
                "NNNN_lowercase_name.sql"
            )

        version = int(match.group("version"))
        if version in seen_versions:
            raise RuntimeError(f"Duplicate migration version: {version}")
        seen_versions.add(version)

        raw = path.read_bytes()
        migrations.append(
            Migration(
                version=version,
                name=match.group("name"),
                path=path,
                checksum=hashlib.sha256(raw).hexdigest(),
                sql=raw.decode("utf-8"),
            )
        )

    return sorted(migrations, key=lambda migration: migration.version)


def connect(database: Path) -> sqlite3.Connection:
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def ensure_migration_table(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL
                DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) STRICT
        """
    )


def applied_migrations(connection: sqlite3.Connection) -> dict[int, sqlite3.Row]:
    return {
        row["version"]: row
        for row in connection.execute(
            """
            SELECT version, name, checksum, applied_at
            FROM schema_migrations
            ORDER BY version
            """
        )
    }


def validate_checksums(
    migrations: list[Migration], applied: dict[int, sqlite3.Row]
) -> None:
    discovered_by_version = {
        migration.version: migration for migration in migrations
    }

    missing_files = sorted(set(applied) - set(discovered_by_version))
    if missing_files:
        versions = ", ".join(str(version) for version in missing_files)
        raise RuntimeError(f"Applied migration files are missing: {versions}")

    for version, row in applied.items():
        migration = discovered_by_version[version]
        if row["name"] != migration.name:
            raise RuntimeError(
                f"Applied migration {version} was renamed from "
                f"{row['name']!r} to {migration.name!r}"
            )
        if row["checksum"] != migration.checksum:
            raise RuntimeError(
                f"Applied migration {migration.path.name} was modified"
            )


def apply_migration(
    connection: sqlite3.Connection, migration: Migration
) -> None:
    # executescript commits pending Python-managed transactions before running,
    # so the migration SQL and metadata insert are deliberately composed into
    # one explicit SQLite transaction here.
    script = f"""
    BEGIN IMMEDIATE;
    {migration.sql}
    INSERT INTO schema_migrations (version, name, checksum)
    VALUES (
        {migration.version},
        {sql_literal(migration.name)},
        {sql_literal(migration.checksum)}
    );
    COMMIT;
    """

    try:
        connection.executescript(script)
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise


def migrate(connection: sqlite3.Connection, directory: Path) -> int:
    ensure_migration_table(connection)
    migrations = discover_migrations(directory)
    applied = applied_migrations(connection)
    validate_checksums(migrations, applied)

    count = 0
    for migration in migrations:
        if migration.version in applied:
            continue
        apply_migration(connection, migration)
        print(f"applied {migration.path.name}")
        count += 1

    if count == 0:
        print("database is up to date")
    return count


def print_status(connection: sqlite3.Connection, directory: Path) -> None:
    ensure_migration_table(connection)
    migrations = discover_migrations(directory)
    applied = applied_migrations(connection)
    validate_checksums(migrations, applied)

    for migration in migrations:
        state = "applied" if migration.version in applied else "pending"
        print(f"{migration.version:04d}  {state:7}  {migration.name}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("up", "status"),
        nargs="?",
        default="up",
        help="operation to perform (default: up)",
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=DEFAULT_DATABASE,
        help=f"SQLite file (default: {DEFAULT_DATABASE})",
    )
    parser.add_argument(
        "--migrations",
        type=Path,
        default=DEFAULT_MIGRATIONS,
        help=f"migration directory (default: {DEFAULT_MIGRATIONS})",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        with connect(args.database.resolve()) as connection:
            if args.command == "up":
                migrate(connection, args.migrations.resolve())
            else:
                print_status(connection, args.migrations.resolve())
    except (RuntimeError, sqlite3.Error, UnicodeError) as error:
        print(f"migration error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
