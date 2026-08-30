import { applyMigrations, openDatabase } from "../db/database";

const databaseFile = process.env.DATABASE_FILE ?? "data/share.db";
const migrationsDirectory = process.env.MIGRATIONS_DIRECTORY ?? "db/migrations";

async function main(): Promise<void> {
  const database = await openDatabase(databaseFile);
  try {
    applyMigrations(database, migrationsDirectory);
    console.log(`database is up to date: ${databaseFile}`);
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
