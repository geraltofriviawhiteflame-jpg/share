from __future__ import annotations

import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MIGRATION_RUNNER = PROJECT_ROOT / "scripts" / "migrate.py"
NOW = "2026-08-29T12:00:00.000Z"
TODAY = "2026-08-29"


class DatabaseSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database = Path(self.temporary_directory.name) / "test.db"
        result = subprocess.run(
            [
                sys.executable,
                str(MIGRATION_RUNNER),
                "up",
                "--database",
                str(self.database),
            ],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("applied 0001_initial.sql", result.stdout)

        self.connection = sqlite3.connect(self.database)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.seed_balanced_expense()

    def tearDown(self) -> None:
        self.connection.close()
        self.temporary_directory.cleanup()

    def seed_balanced_expense(self) -> None:
        self.connection.executemany(
            """
            INSERT INTO users (id, email, display_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                ("user-anil", "anil@example.com", "Anil", NOW, NOW),
                ("user-beena", "beena@example.com", "Beena", NOW, NOW),
                ("user-charan", "charan@example.com", "Charan", NOW, NOW),
            ],
        )
        self.connection.execute(
            """
            INSERT INTO groups (
                id,
                name,
                created_by_user_id,
                created_at,
                updated_at
            )
            VALUES ('group-trip', 'Trip', 'user-anil', ?, ?)
            """,
            (NOW, NOW),
        )
        self.connection.executemany(
            """
            INSERT INTO group_members (
                id,
                group_id,
                user_id,
                role,
                joined_at,
                created_at,
                updated_at
            )
            VALUES (?, 'group-trip', ?, ?, ?, ?, ?)
            """,
            [
                ("member-anil", "user-anil", "owner", NOW, NOW, NOW),
                ("member-beena", "user-beena", "member", NOW, NOW, NOW),
                ("member-charan", "user-charan", "member", NOW, NOW, NOW),
            ],
        )
        self.connection.execute(
            """
            INSERT INTO expenses (
                id,
                group_id,
                description,
                amount_paise,
                expense_date,
                split_method,
                created_by_member_id,
                updated_by_member_id,
                created_at,
                updated_at
            )
            VALUES (
                'expense-dinner',
                'group-trip',
                'Dinner',
                120000,
                ?,
                'equal',
                'member-anil',
                'member-anil',
                ?,
                ?
            )
            """,
            (TODAY, NOW, NOW),
        )
        self.connection.execute(
            """
            INSERT INTO expense_payers (
                group_id,
                expense_id,
                member_id,
                amount_paise
            )
            VALUES ('group-trip', 'expense-dinner', 'member-anil', 120000)
            """
        )
        self.connection.executemany(
            """
            INSERT INTO expense_shares (
                group_id,
                expense_id,
                member_id,
                owed_paise
            )
            VALUES ('group-trip', 'expense-dinner', ?, ?)
            """,
            [
                ("member-anil", 40000),
                ("member-beena", 40000),
                ("member-charan", 40000),
            ],
        )
        self.connection.commit()

    def balances(self) -> dict[str, int]:
        return {
            row["member_id"]: row["balance_paise"]
            for row in self.connection.execute(
                """
                SELECT member_id, balance_paise
                FROM group_member_balances
                WHERE group_id = 'group-trip'
                ORDER BY member_id
                """
            )
        }

    def test_balance_view_applies_expenses_and_settlements(self) -> None:
        self.assertEqual(
            self.balances(),
            {
                "member-anil": 80000,
                "member-beena": -40000,
                "member-charan": -40000,
            },
        )

        self.connection.execute(
            """
            INSERT INTO settlements (
                id,
                group_id,
                paid_by_member_id,
                received_by_member_id,
                amount_paise,
                settlement_date,
                payment_method,
                created_by_member_id,
                updated_by_member_id,
                created_at,
                updated_at
            )
            VALUES (
                'settlement-beena-anil',
                'group-trip',
                'member-beena',
                'member-anil',
                40000,
                ?,
                'upi',
                'member-beena',
                'member-beena',
                ?,
                ?
            )
            """,
            (TODAY, NOW, NOW),
        )

        self.assertEqual(
            self.balances(),
            {
                "member-anil": 40000,
                "member-beena": 0,
                "member-charan": -40000,
            },
        )
        self.assertEqual(sum(self.balances().values()), 0)

    def test_soft_deleted_expense_stops_affecting_balances(self) -> None:
        self.connection.execute(
            """
            UPDATE expenses
            SET deleted_at = ?,
                deleted_by_member_id = 'member-anil',
                updated_by_member_id = 'member-anil',
                updated_at = ?,
                version = version + 1
            WHERE id = 'expense-dinner'
            """,
            (NOW, NOW),
        )

        self.assertEqual(
            self.balances(),
            {
                "member-anil": 0,
                "member-beena": 0,
                "member-charan": 0,
            },
        )

    def test_cross_group_financial_reference_is_rejected(self) -> None:
        self.connection.execute(
            """
            INSERT INTO users (id, email, display_name, created_at, updated_at)
            VALUES ('user-other', 'other@example.com', 'Other', ?, ?)
            """,
            (NOW, NOW),
        )
        self.connection.execute(
            """
            INSERT INTO groups (
                id,
                name,
                created_by_user_id,
                created_at,
                updated_at
            )
            VALUES ('group-other', 'Other group', 'user-other', ?, ?)
            """,
            (NOW, NOW),
        )
        self.connection.execute(
            """
            INSERT INTO group_members (
                id,
                group_id,
                user_id,
                role,
                joined_at,
                created_at,
                updated_at
            )
            VALUES (
                'member-other',
                'group-other',
                'user-other',
                'owner',
                ?,
                ?,
                ?
            )
            """,
            (NOW, NOW, NOW),
        )

        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute(
                """
                INSERT INTO expense_payers (
                    group_id,
                    expense_id,
                    member_id,
                    amount_paise
                )
                VALUES (
                    'group-trip',
                    'expense-dinner',
                    'member-other',
                    100
                )
                """
            )

    def test_membership_and_owner_uniqueness_are_enforced(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute(
                """
                INSERT INTO group_members (
                    id,
                    group_id,
                    user_id,
                    role,
                    joined_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    'member-anil-duplicate',
                    'group-trip',
                    'user-anil',
                    'member',
                    ?,
                    ?,
                    ?
                )
                """,
                (NOW, NOW, NOW),
            )

        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute(
                """
                UPDATE group_members
                SET role = 'owner', updated_at = ?
                WHERE id = 'member-beena'
                """,
                (NOW,),
            )

    def test_invalid_settlement_and_activity_json_are_rejected(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute(
                """
                INSERT INTO settlements (
                    id,
                    group_id,
                    paid_by_member_id,
                    received_by_member_id,
                    amount_paise,
                    settlement_date,
                    payment_method,
                    created_by_member_id,
                    updated_by_member_id,
                    created_at,
                    updated_at
                )
                VALUES (
                    'settlement-invalid',
                    'group-trip',
                    'member-anil',
                    'member-anil',
                    100,
                    ?,
                    'cash',
                    'member-anil',
                    'member-anil',
                    ?,
                    ?
                )
                """,
                (TODAY, NOW, NOW),
            )

        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute(
                """
                INSERT INTO activity_events (
                    id,
                    group_id,
                    actor_member_id,
                    entity_type,
                    entity_id,
                    action,
                    after_json,
                    created_at
                )
                VALUES (
                    'event-invalid-json',
                    'group-trip',
                    'member-anil',
                    'expense',
                    'expense-dinner',
                    'created',
                    '{not-json}',
                    ?
                )
                """,
                (NOW,),
            )

    def test_allocation_diagnostic_view_flags_inconsistent_totals(self) -> None:
        balanced = self.connection.execute(
            """
            SELECT is_balanced
            FROM expense_allocation_totals
            WHERE expense_id = 'expense-dinner'
            """
        ).fetchone()
        self.assertEqual(balanced["is_balanced"], 1)

        # Aggregate sums cannot be expressed as a normal SQLite CHECK
        # constraint. This direct SQL mutation demonstrates why the future
        # expense service must validate the sums within its write transaction.
        self.connection.execute(
            """
            UPDATE expense_shares
            SET owed_paise = 39999
            WHERE expense_id = 'expense-dinner'
              AND member_id = 'member-charan'
            """
        )

        inconsistent = self.connection.execute(
            """
            SELECT amount_paise, paid_paise, owed_paise, is_balanced
            FROM expense_allocation_totals
            WHERE expense_id = 'expense-dinner'
            """
        ).fetchone()
        self.assertEqual(inconsistent["amount_paise"], 120000)
        self.assertEqual(inconsistent["paid_paise"], 120000)
        self.assertEqual(inconsistent["owed_paise"], 119999)
        self.assertEqual(inconsistent["is_balanced"], 0)

    def test_migration_runner_skips_an_applied_migration(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(MIGRATION_RUNNER),
                "up",
                "--database",
                str(self.database),
            ],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("database is up to date", result.stdout)


if __name__ == "__main__":
    unittest.main()
