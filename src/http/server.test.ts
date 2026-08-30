import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { openDatabase, applyMigrations } from "../db/database";
import { AccountService } from "../services/accounts";
import { BalanceService } from "../services/balance";
import { ExpenseService } from "../services/expenses";
import { GroupService } from "../services/groups";
import { SettlementService } from "../services/settlements";
import { createHandler } from "./server";

/** Test-only view of a response; `json` stays loose to keep assertions terse. */
type Response = {
  status: number;
  contentType: string;
  csp: string;
  allow: string;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
};

/** Boots the real handler so the mobile client's exact calls are covered. */
async function startServer() {
  const directory = mkdtempSync(join(tmpdir(), "share-http-"));
  const database = await openDatabase(join(directory, "share.db"));
  applyMigrations(database, join(process.cwd(), "db/migrations"));
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const request = async (
    path: string,
    { method = "GET", body }: { method?: string; body?: unknown } = {},
  ): Promise<Response> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      contentType,
      csp: response.headers.get("content-security-policy") ?? "",
      allow: response.headers.get("allow") ?? "",
      text,
      // Any JSON-ish media type, so application/manifest+json parses too.
      json: contentType.includes("json") ? JSON.parse(text) : null,
    };
  };

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        database.close();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

  return { request, close };
}

test("serves the mobile client with a locked-down document", async () => {
  const { request, close } = await startServer();
  try {
    const shell = await request("/");
    assert.equal(shell.status, 200);
    assert.match(shell.contentType, /text\/html/);
    assert.match(shell.text, /<title>Share<\/title>/);
    assert.match(shell.text, /rel="manifest"/);
    // The client ships as separate files, so a strict CSP stays affordable.
    assert.match(shell.csp, /default-src 'self'/);
    assert.match(shell.csp, /frame-ancestors 'none'/);
    assert.ok(!shell.text.includes("<script>"), "no inline script");
    assert.ok(!shell.text.includes("style="), "no inline style attribute");

    const script = await request("/app/app.js");
    assert.equal(script.status, 200);
    assert.match(script.contentType, /javascript/);
    assert.match(await request("/app/styles.css").then((r) => r.contentType), /text\/css/);
    assert.equal((await request("/app/manifest.webmanifest")).json.name, "Share — split expenses");
    assert.equal((await request("/app/nope.js")).status, 404);
    // The asset map is a literal whitelist, so an encoded traversal is a 404.
    assert.equal((await request("/app/%2e%2e/package.json")).status, 404);
    assert.equal((await request("/package.json")).status, 404);

    const post = await request("/", { method: "POST", body: {} });
    assert.equal(post.status, 405);
    assert.equal(post.allow, "GET");
  } finally {
    await close();
  }
});

test("the client flow works: people, group, roster, expense, balances, settlement", async () => {
  const { request, close } = await startServer();
  try {
    const anil = (await request("/v1/users", {
      method: "POST",
      body: { email: "anil@example.com", display_name: "Anil" },
    })).json;
    const beena = (await request("/v1/users", {
      method: "POST",
      body: { email: "beena@example.com", display_name: "Beena" },
    })).json;

    // The onboarding screen reads this list to pick a person.
    const people = await request("/v1/users");
    assert.equal(people.status, 200);
    assert.deepEqual(
      people.json.map((user: { display_name: string }) => user.display_name),
      ["Anil", "Beena"],
    );

    const group = (await request("/v1/groups", {
      method: "POST",
      body: { owner_user_id: anil.id, name: "Goa trip", simplify_debts: true },
    })).json;
    const mine = (await request(`/v1/groups?user_id=${anil.id}`)).json[0];
    assert.equal(mine.group_id, group.id);
    assert.equal(mine.role, "owner");
    assert.equal(mine.member_id, group.owner_member_id);

    await request(`/v1/groups/${group.id}/members`, {
      method: "POST",
      body: { actor_member_id: group.owner_member_id, user_id: beena.id },
    });

    // The picker for payer/participants reads the roster.
    const roster = await request(`/v1/groups/${group.id}/members`);
    assert.equal(roster.status, 200);
    assert.deepEqual(
      roster.json.map((member: { display_name: string; role: string }) => [
        member.display_name,
        member.role,
      ]),
      [
        ["Anil", "owner"],
        ["Beena", "member"],
      ],
    );
    const beenaMember = roster.json[1].member_id;

    const expense = await request(`/v1/groups/${group.id}/expenses`, {
      method: "POST",
      body: {
        actor_member_id: group.owner_member_id,
        description: "Dinner",
        amount_paise: 1001,
        expense_date: "2026-08-30",
        category: "food",
        split_method: "equal",
        payer_member_id: group.owner_member_id,
        participant_member_ids: [group.owner_member_id, beenaMember],
      },
    });
    assert.equal(expense.status, 201);
    // One paise of rounding goes to the member id that sorts first.
    assert.deepEqual(
      expense.json.shares.map((share: { owed_paise: number }) => share.owed_paise).sort(),
      [500, 501],
    );

    const balances = (await request(`/v1/groups/${group.id}/balances`)).json;
    // Which member absorbs the single leftover paisa depends on member-id
    // order, so the expectation is derived from the stored shares.
    const anilShare = expense.json.shares.find(
      (share: { member_id: string }) => share.member_id === group.owner_member_id,
    );
    const beenaShare = expense.json.shares.find(
      (share: { member_id: string }) => share.member_id === beenaMember,
    );
    assert.equal(anilShare.owed_paise + beenaShare.owed_paise, 1001);
    const anilBalance = balances.balances.find((row: { user_id: string }) => row.user_id === anil.id);
    assert.equal(anilBalance.balance_paise, 1001 - anilShare.owed_paise);
    const beenaBalance = balances.balances.find(
      (row: { user_id: string }) => row.user_id === beena.id,
    );
    assert.equal(beenaBalance.balance_paise, -beenaShare.owed_paise);
    assert.equal(balances.total_paise, 0);
    assert.equal(balances.suggested_transfers.length, 1);

    // The client prefills this from the suggestion, then records it as UPI.
    const suggested = balances.suggested_transfers[0];
    const settled = await request(`/v1/groups/${group.id}/settlements`, {
      method: "POST",
      body: {
        actor_member_id: group.owner_member_id,
        paid_by_member_id: suggested.from_member_id,
        received_by_member_id: suggested.to_member_id,
        amount_paise: suggested.amount_paise,
        settlement_date: "2026-08-30",
        payment_method: "upi",
      },
    });
    assert.equal(settled.status, 201);

    const listed = await request(`/v1/groups/${group.id}/settlements?limit=10`);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.length, 1);
    assert.equal(listed.json[0].amount_paise, suggested.amount_paise);
    assert.equal(listed.json[0].payment_method, "upi");

    const after = (await request(`/v1/groups/${group.id}/balances`)).json;
    assert.deepEqual(
      after.balances.map((row: { balance_paise: number }) => row.balance_paise),
      [0, 0],
    );
    assert.deepEqual(after.suggested_transfers, []);
    assert.equal(after.total_paise, 0);
  } finally {
    await close();
  }
});

test("bad query and body input return the client-readable error shape", async () => {
  const { request, close } = await startServer();
  try {
    const user = (await request("/v1/users", {
      method: "POST",
      body: { email: "solo@example.com", display_name: "Solo" },
    })).json;
    const group = (await request("/v1/groups", {
      method: "POST",
      body: { owner_user_id: user.id, name: "Flat" },
    })).json;

    const badLimit = await request(`/v1/groups/${group.id}/settlements?limit=abc`);
    assert.equal(badLimit.status, 400);
    assert.match(badLimit.json.message, /limit must be an integer/);

    const missing = await request("/v1/groups/does-not-exist/members");
    assert.equal(missing.status, 404);

    const unknownGroup = await request("/v1/groups/does-not-exist/settlements");
    assert.equal(unknownGroup.status, 404);

    const noBody = await request("/v1/users", { method: "POST" });
    assert.equal(noBody.status, 400);
    assert.match(noBody.json.message, /valid JSON/);
  } finally {
    await close();
  }
});
