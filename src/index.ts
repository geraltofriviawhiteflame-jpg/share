import { createServer } from "node:http";
import { applyMigrations, openDatabase } from "./db/database";
import { createHandler } from "./http/server";
import { AccountService } from "./services/accounts";
import { BalanceService } from "./services/balance";
import { ExpenseService } from "./services/expenses";
import { GroupService } from "./services/groups";
import { SettlementService } from "./services/settlements";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const databaseFile = process.env.DATABASE_FILE ?? "data/share.db";
const migrationsDirectory = process.env.MIGRATIONS_DIRECTORY ?? "db/migrations";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

async function main(): Promise<void> {
  const database = await openDatabase(databaseFile);
  applyMigrations(database, migrationsDirectory);

  const server = createServer(
    createHandler({
      database,
      accounts: new AccountService(database),
      groups: new GroupService(database),
      expenses: new ExpenseService(database),
      balances: new BalanceService(database),
      settlements: new SettlementService(database),
    }),
  );

  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 60_000;
  server.listen(port, host, () => {
    console.log(`share API listening on http://${host}:${port}`);
  });

  function shutdown(signal: string): void {
    console.log(`${signal} received; shutting down`);
    server.close((error) => {
      database.close();
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
