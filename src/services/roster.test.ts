import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase, applyMigrations } from "../db/database";
import { AccountService } from "./accounts";
import { GroupService } from "./groups";
import { ExpenseService } from "./expenses";
import { SettlementService } from "./settlements";

/**
 * The read side the mobile client depends on: the roster and settlement list
 * that used to be write-only, plus the user list. Amounts stay in paise.
 */
async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "share-roster-"));
  const database = await openDatabase(join(directory, "share.db"));
  applyMigrations(database, join(process.cwd(), "db/migrations"));

  const accounts = new AccountService(database);
  const groups = new GroupService(database);
  const settlements = new SettlementService(database);
  const expenses = new ExpenseService(database);

  const anil = accounts.createUser({ email: "anil@example.com", displayName: "Anil" });
  const beena = accounts.createUser({ email: "beena@example.com", displayName: "Beena" });
  const charan = accounts.createUser({ email: "charan@example.com", displayName: "Charan" });
  const group = groups.create({ ownerUserId: anil.id, name: "Trip" });
  const beenaMember = groups.addMember({
    groupId: group.id,
    actorMemberId: group.ownerMemberId,
    userId: beena.id,
  });
  groups.addMember({
    groupId: group.id,
    actorMemberId: group.ownerMemberId,
    userId: charan.id,
    role: "admin",
  });

  return {
    database,
    accounts,
    groups,
    expenses,
    settlements,
    users: { anil, beena, charan },
    group,
    members: { anil: group.ownerMemberId, beena: beenaMember.memberId },
  };
}

test("listUsers returns active accounts ordered by display name", async () => {
  const { accounts, users } = await createFixture();
  const listed = accounts.listUsers();

  assert.deepEqual(
    listed.map((user) => user.displayName),
    ["Anil", "Beena", "Charan"],
  );
  assert.equal(listed[0].email, "anil@example.com");
  assert.equal(listed[0].timezone, "Asia/Kolkata");
  assert.equal(listed.find((user) => user.id === users.anil.id)?.id, users.anil.id);
});

test("listUsers hides soft-deleted accounts", async () => {
  const { database, accounts, users } = await createFixture();
  database
    .prepare(`UPDATE users SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(users.beena.id);

  assert.deepEqual(
    accounts.listUsers().map((user) => user.displayName),
    ["Anil", "Charan"],
  );
});

test("listMembers returns the roster with display names and roles", async () => {
  const { groups, group } = await createFixture();
  const roster = groups.listMembers(group.id);

  assert.equal(roster.length, 3);
  assert.deepEqual(
    roster.map((member) => [member.displayName, member.role]),
    [
      ["Anil", "owner"],
      ["Beena", "member"],
      ["Charan", "admin"],
    ],
  );
  assert.ok(roster.every((member) => member.status === "active"));
  assert.ok(roster.every((member) => member.groupId === group.id));
});

test("listMembers keeps a departed member so history stays readable", async () => {
  const { database, groups, group, members } = await createFixture();
  database
    .prepare(`UPDATE group_members SET status = 'left', left_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(members.beena);

  const roster = groups.listMembers(group.id);
  assert.equal(roster.length, 3);
  assert.deepEqual(
    roster.map((member) => [member.displayName, member.status]),
    [
      ["Anil", "active"],
      ["Charan", "active"],
      ["Beena", "left"],
    ],
  );
});

test("listMembers rejects an unknown group", async () => {
  const { groups } = await createFixture();
  await assert.rejects(
    Promise.resolve().then(() => groups.listMembers("00000000-0000-4000-8000-000000000000")),
    /group was not found/,
  );
});

test("settlement list is newest-first and page-size clamped", async () => {
  const { settlements, group, members } = await createFixture();
  const record = (amountPaise: number, settlementDate: string) =>
    settlements.create({
      groupId: group.id,
      actorMemberId: members.anil,
      paidByMemberId: members.beena,
      receivedByMemberId: members.anil,
      amountPaise,
      settlementDate,
      paymentMethod: "upi",
      notes: amountPaise === 40_000 ? "Paid through UPI" : undefined,
    });
  record(40_000, "2026-08-01");
  record(60_000, "2026-08-20");

  const listed = settlements.list(group.id, 10);
  assert.deepEqual(
    listed.map((settlement) => [settlement.amountPaise, settlement.settlementDate]),
    [
      [60_000, "2026-08-20"],
      [40_000, "2026-08-01"],
    ],
  );
  assert.equal(listed[1].notes, "Paid through UPI");
  assert.equal(listed[0].currency, "INR");
  assert.equal(listed[0].version, 1);

  // Out-of-range page sizes fall back to the default instead of erroring.
  assert.equal(settlements.list(group.id, 500).length, 2);
  assert.equal(settlements.list(group.id, 0).length, 2);
  assert.equal(settlements.list(group.id, 1).length, 1);
});
