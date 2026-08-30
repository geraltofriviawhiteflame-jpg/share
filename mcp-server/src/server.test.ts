import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { applyMigrations, openDatabase } from "../../src/db/database";
import { AccountService } from "../../src/services/accounts";
import { BalanceService } from "../../src/services/balance";
import { ExpenseService } from "../../src/services/expenses";
import { GroupService } from "../../src/services/groups";
import { SettlementService } from "../../src/services/settlements";
import { createLogger, silentLogger } from "./log";
import { createShareMcpServer } from "./server";

async function connect() {
  const database = await openDatabase(":memory:");
  applyMigrations(database, join(__dirname, "..", "..", "db", "migrations"));
  const server = createShareMcpServer(
    {
      database,
      accounts: new AccountService(database),
      groups: new GroupService(database),
      expenses: new ExpenseService(database),
      balances: new BalanceService(database),
      settlements: new SettlementService(database),
    },
    { logger: silentLogger() },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "share-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, database };
}

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): unknown {
  const text = result.content?.[0]?.text ?? "";
  return JSON.parse(text);
}

test("exposes the full tool surface", async () => {
  const { client, database } = await connect();
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "add_member",
      "create_expense",
      "create_group",
      "create_settlement",
      "create_user",
      "get_balances",
      "list_expenses",
      "list_groups",
      "list_members",
      "list_settlements",
      "list_users",
    ]);
  } finally {
    await client.close();
    database.close();
  }
});

test("full happy path: user, group, member, expense, balances, settlement", async () => {
  const { client, database } = await connect();
  try {
    const created = await client.callTool({
      name: "create_user",
      arguments: { email: "anil@example.com", display_name: "Anil" },
    });
    const user = textOf(created) as { id: string };

    const secondUser = textOf(
      await client.callTool({
        name: "create_user",
        arguments: { email: "beena@example.com", display_name: "Beena" },
      }),
    ) as { id: string };

    const groupResult = await client.callTool({
      name: "create_group",
      arguments: { owner_user_id: user.id, name: "Flat 4B" },
    });
    const group = textOf(groupResult) as {
      id: string;
      owner_member_id: string;
    };

    const memberResult = await client.callTool({
      name: "add_member",
      arguments: {
        group_id: group.id,
        actor_member_id: group.owner_member_id,
        user_id: secondUser.id,
      },
    });
    const member = textOf(memberResult) as { member_id: string };

    const expenseResult = await client.callTool({
      name: "create_expense",
      arguments: {
        group_id: group.id,
        actor_member_id: group.owner_member_id,
        description: "Groceries",
        amount_paise: 1000,
        expense_date: "2026-08-30",
        split_method: "exact",
        payer_member_id: group.owner_member_id,
        exact_shares: [{ member_id: member.member_id, owed_paise: 1000 }],
      },
    });
    const expense = textOf(expenseResult) as { id: string; amount_paise: number };
    assert.equal(expense.amount_paise, 1000);

    const balances = textOf(
      await client.callTool({
        name: "get_balances",
        arguments: { group_id: group.id },
      }),
    ) as { balances: Array<{ balance_paise: number }> };
    assert.equal(balances.balances.length, 2);

    const settlement = textOf(
      await client.callTool({
        name: "create_settlement",
        arguments: {
          group_id: group.id,
          actor_member_id: group.owner_member_id,
          paid_by_member_id: member.member_id,
          received_by_member_id: group.owner_member_id,
          amount_paise: 1000,
          settlement_date: "2026-08-30",
          payment_method: "upi",
        },
      }),
    ) as { id: string; amount_paise: number };
    assert.equal(settlement.amount_paise, 1000);

    const lists = await Promise.all([
      client.callTool({ name: "list_users", arguments: {} }),
      client.callTool({ name: "list_groups", arguments: { user_id: user.id } }),
      client.callTool({ name: "list_members", arguments: { group_id: group.id } }),
      client.callTool({ name: "list_expenses", arguments: { group_id: group.id } }),
      client.callTool({
        name: "list_settlements",
        arguments: { group_id: group.id },
      }),
    ]);
    for (const list of lists) {
      assert.ok(Array.isArray(textOf(list)));
    }
    assert.equal((textOf(lists[0]) as unknown[]).length, 2); // users
    assert.equal((textOf(lists[1]) as unknown[]).length, 1); // groups
    assert.equal((textOf(lists[2]) as unknown[]).length, 2); // members
    assert.equal((textOf(lists[3]) as unknown[]).length, 1); // expenses
    assert.equal((textOf(lists[4]) as unknown[]).length, 1); // settlements
  } finally {
    await client.close();
    database.close();
  }
});

test("advertises the logging capability", async () => {
  const { client, database } = await connect();
  try {
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities?.logging);
  } finally {
    await client.close();
    database.close();
  }
});

test("logs tool invocations and domain rejections", async () => {
  const chunks: string[] = [];
  const logger = createLogger({
    name: "share-mcp-server",
    level: "info",
    format: "json",
    stream: { write: (chunk) => chunks.push(String(chunk)) },
  });
  const database = await openDatabase(":memory:");
  applyMigrations(database, join(__dirname, "..", "..", "db", "migrations"));
  const server = createShareMcpServer(
    {
      database,
      accounts: new AccountService(database),
      groups: new GroupService(database),
      expenses: new ExpenseService(database),
      balances: new BalanceService(database),
      settlements: new SettlementService(database),
    },
    { logger },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "share-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    await client.callTool({
      name: "create_user",
      arguments: { email: "log@example.com", display_name: "Log" },
    });
    await client.callTool({
      name: "create_user",
      arguments: { email: "not-an-email", display_name: "Bad" },
    });
    const records = chunks.map((line) => JSON.parse(line) as {
      msg: string;
      tool?: string;
      ok?: boolean;
      kind?: string;
    });
    assert.ok(
      records.some((record) => record.msg === "tool.done" && record.tool === "create_user" && record.ok === true),
    );
    assert.ok(
      records.some(
        (record) =>
          record.msg === "tool.rejected" &&
          record.tool === "create_user" &&
          record.kind === "validation",
      ),
    );
  } finally {
    await client.close();
    database.close();
  }
});

test("domain failures surface as isError tool results with the message", async () => {
  const { client, database } = await connect();
  try {
    const result = await client.callTool({
      name: "create_user",
      arguments: { email: "not-an-email", display_name: "Bad" },
    });
    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.match(content[0]?.text ?? "", /email must be a valid/);
  } finally {
    await client.close();
    database.close();
  }
});
