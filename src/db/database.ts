import initSqlJs from "sql.js";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

type SqlValue = number | string | Uint8Array | null;
type NamedValues = Record<string, SqlValue | undefined>;
type Migration = {
  version: number;
  name: string;
  checksum: string;
  sql: string;
};
type AppliedMigration = {
  version: number;
  name: string;
  checksum: string;
};

const migrationPattern = /^(\d+)_([a-z0-9_]+)\.sql$/;

/**
 * A small sql.js adapter with the subset of the synchronous SQLite API used by
 * this project. sql.js is SQLite compiled to WebAssembly, which lets the
 * preview run without a native compiler. It loads and saves a SQLite file, so
 * the schema and application behavior remain the same for this MVP.
 */
export class SQLiteDatabase {
  private transactionDepth = 0;
  private dirty = false;

  public constructor(
    private readonly raw: initSqlJs.Database,
    private readonly filename: string,
  ) {}

  public pragma(statement: string): void {
    this.raw.exec(`PRAGMA ${statement}`);
  }

  public exec(sql: string): void {
    this.raw.exec(sql);
    this.markDirty();
  }

  public prepare(sql: string): SQLiteStatement {
    return new SQLiteStatement(this, sql);
  }

  public transaction<T>(callback: () => T): () => T {
    return () => {
      if (this.transactionDepth > 0) {
        return callback();
      }
      this.raw.exec("BEGIN IMMEDIATE");
      this.transactionDepth += 1;
      try {
        const result = callback();
        this.raw.exec("COMMIT");
        this.transactionDepth -= 1;
        this.persistIfDirty();
        return result;
      } catch (error) {
        try {
          this.raw.exec("ROLLBACK");
        } finally {
          this.transactionDepth -= 1;
          this.dirty = false;
        }
        throw error;
      }
    };
  }

  public close(): void {
    this.persistIfDirty();
    this.raw.close();
  }

  public runStatement(sql: string, parameters: unknown[]): { changes: number } {
    const statement = this.raw.prepare(sql);
    try {
      bind(statement, sql, parameters);
      statement.step();
      return { changes: this.raw.getRowsModified() };
    } finally {
      statement.free();
      this.markDirty();
    }
  }

  public getStatement(sql: string, parameters: unknown[]): Record<string, unknown> | undefined {
    const statement = this.raw.prepare(sql);
    try {
      bind(statement, sql, parameters);
      if (!statement.step()) {
        return undefined;
      }
      return statement.getAsObject() as Record<string, unknown>;
    } finally {
      statement.free();
    }
  }

  public allStatements(sql: string, parameters: unknown[]): Array<Record<string, unknown>> {
    const statement = this.raw.prepare(sql);
    try {
      bind(statement, sql, parameters);
      const rows: Array<Record<string, unknown>> = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as Record<string, unknown>);
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  private markDirty(): void {
    this.dirty = true;
    this.persistIfDirty();
  }

  private persistIfDirty(): void {
    if (!this.dirty || this.transactionDepth > 0 || this.filename === ":memory:") {
      return;
    }
    writeFileSync(this.filename, Buffer.from(this.raw.export()));
    this.dirty = false;
  }
}

export class SQLiteStatement {
  public constructor(
    private readonly database: SQLiteDatabase,
    private readonly sql: string,
  ) {}

  public run(...parameters: unknown[]): { changes: number } {
    return this.database.runStatement(this.sql, parameters);
  }

  public get(...parameters: unknown[]): Record<string, unknown> | undefined {
    return this.database.getStatement(this.sql, parameters);
  }

  public all(...parameters: unknown[]): Array<Record<string, unknown>> {
    return this.database.allStatements(this.sql, parameters);
  }
}

/** Open a file-backed SQLite/WASM database and configure its invariants. */
export async function openDatabase(filename: string): Promise<SQLiteDatabase> {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o750 });
  }

  const SQL = await initSqlJs({
    locateFile: (file) => join(dirname(require.resolve("sql.js")), file),
  });
  const data = filename !== ":memory:" && existsSync(filename)
    ? readFileSync(filename)
    : undefined;
  const database = new SQLiteDatabase(new SQL.Database(data), filename);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("journal_mode = WAL");
  return database;
}

/** Apply immutable, checksummed SQL migrations in version order. */
export function applyMigrations(
  database: SQLiteDatabase,
  migrationsDirectory: string,
): void {
  const migrations = discoverMigrations(migrationsDirectory);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT
  `);

  const applied = database
    .prepare(
      `SELECT version, name, checksum
       FROM schema_migrations
       ORDER BY version`,
    )
    .all() as unknown as AppliedMigration[];
  const appliedByVersion = new Map(
    applied.map((migration) => [migration.version, migration]),
  );
  const discoveredByVersion = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );

  for (const record of applied) {
    const migration = discoveredByVersion.get(record.version);
    if (!migration) {
      throw new Error(`applied migration file is missing: ${record.version}`);
    }
    if (record.name !== migration.name) {
      throw new Error(
        `applied migration ${record.version} was renamed from ${record.name} to ${migration.name}`,
      );
    }
    if (record.checksum !== migration.checksum) {
      throw new Error(`applied migration ${migration.name} was modified`);
    }
  }

  const insertMigration = database.prepare(`
    INSERT INTO schema_migrations (version, name, checksum)
    VALUES (?, ?, ?)
  `);
  for (const migration of migrations) {
    if (appliedByVersion.has(migration.version)) {
      continue;
    }
    const applyOne = database.transaction(() => {
      database.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, migration.checksum);
    });
    applyOne();
  }
}

function discoverMigrations(directory: string): Migration[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const seenVersions = new Set<number>();
  const migrations: Migration[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      continue;
    }
    const match = migrationPattern.exec(entry.name);
    if (!match) {
      if (entry.name.endsWith(".sql")) {
        throw new Error(`invalid migration filename: ${entry.name}`);
      }
      continue;
    }
    const version = Number.parseInt(match[1], 10);
    if (seenVersions.has(version)) {
      throw new Error(`duplicate migration version: ${version}`);
    }
    seenVersions.add(version);
    const path = join(directory, entry.name);
    const raw = readFileSync(path);
    migrations.push({
      version,
      name: match[2],
      checksum: createHash("sha256").update(raw).digest("hex"),
      sql: raw.toString("utf8"),
    });
  }
  return migrations.sort((left, right) => left.version - right.version);
}

function bind(
  statement: initSqlJs.Statement,
  sql: string,
  parameters: unknown[],
): void {
  if (!parameters.length) {
    return;
  }
  const first = parameters[0];
  if (
    parameters.length === 1 &&
    first !== null &&
    typeof first === "object" &&
    !Array.isArray(first) &&
    !(first instanceof Uint8Array)
  ) {
    const values = first as NamedValues;
    const namedParameters: Record<string, SqlValue> = {};
    for (const match of sql.matchAll(/[@:$][A-Za-z_][A-Za-z0-9_]*/g)) {
      const name = match[0];
      const key = name.slice(1);
      const value = values[key] ?? values[name];
      namedParameters[name] = value === undefined ? null : value;
    }
    statement.bind(namedParameters);
    return;
  }
  statement.bind(parameters.map(toSqlValue));
}

function toSqlValue(value: unknown): SqlValue {
  if (value === undefined) {
    return null;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new TypeError("unsupported SQLite parameter type");
}
