import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase, applyMigrations } from "../db/database";
import { AccountService } from "./accounts";
import { BalanceService } from "./balance";
import { GroupService } from "./groups";
import { ExpenseService, prepareShares } from "./expenses";
import { DomainError } from "../domain/errors";

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "share-expenses-"));
  const database = await openDatabase(join(directory, "share.db"));
  applyMigrations(database, join(process.cwd(), "db/migrations"));

  const accounts = new AccountService(database);
  const groups = new GroupService(database);
  const owner = accounts.createUser({
    email: "owner@example.com",
    displayName: "Owner",
  });
  const beena = accounts.createUser({
    email: "beena@example.com",
    displayName: "Beena",
  });
  const charan = accounts.createUser({
    email: "charan@example.com",
    displayName: "Charan",
  });
  const group = groups.create({ ownerUserId: owner.id, name: "Trip" });
  const beenaMember = groups.addMember({
    groupId: group.id,
    actorMemberId: group.ownerMemberId,
    userId: beena.id,
  });
  const charanMember = groups.addMember({
    groupId: group.id,
    actorMemberId: group.ownerMemberId,
    userId: charan.id,
  });

  return {
    database,
    directory,
    group,
    members: {
      owner: group.ownerMemberId,
      beena: beenaMember.memberId,
      charan: charanMember.memberId,
    },
  };
}

test("prepareShares allocates an equal-split remainder by member ID", () => {
  assert.deepEqual(
    prepareShares({
      groupId: "group",
      actorMemberId: "member-a",
      description: "Tea",
      amountPaise: 100,
      expenseDate: "2026-08-29",
      splitMethod: "equal",
      payerMemberId: "member-a",
      participantMemberIds: ["member-c", "member-a", "member-b"],
    }),
    [
      { memberId: "member-a", owedPaise: 34 },
      { memberId: "member-b", owedPaise: 33 },
      { memberId: "member-c", owedPaise: 33 },
    ],
  );
});

test("create writes the expense allocation and audit event atomically", async (t) => {
  const fixture = await createFixture();
  t.after(() => {
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });

  const expense = new ExpenseService(fixture.database).create({
    groupId: fixture.group.id,
    actorMemberId: fixture.members.owner,
    description: "Tea",
    amountPaise: 100,
    expenseDate: "2026-08-29",
    splitMethod: "equal",
    payerMemberId: fixture.members.owner,
    participantMemberIds: [
      fixture.members.owner,
      fixture.members.beena,
      fixture.members.charan,
    ],
  });

  assert.equal(expense.shares.reduce((sum, share) => sum + share.owedPaise, 0), 100);
  const eventCount = fixture.database
    .prepare(
      `SELECT COUNT(*) AS count FROM activity_events
       WHERE entity_type = 'expense' AND entity_id = ?`,
    )
    .get(expense.id) as { count: number };
  assert.equal(eventCount.count, 1);

  const balances = new BalanceService(fixture.database).forGroup(fixture.group.id);
  assert.equal(balances.totalPaise, 0);
  assert.equal(balances.suggestedTransfers.length, 2);
});

test("create rejects an exact split that does not balance", () => {
  assert.throws(
    () =>
      prepareShares({
        groupId: "group",
        actorMemberId: "member-a",
        description: "Dinner",
        amountPaise: 100,
        expenseDate: "2026-08-29",
        splitMethod: "exact",
        payerMemberId: "member-a",
        exactShares: [{ memberId: "member-a", owedPaise: 99 }],
      }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.kind === "validation" &&
      error.message.includes("sum to amount_paise"),
  );
});
