#!/usr/bin/env node
/**
 * Seeds a demo group through the public API so the mobile client has something
 * to show on a phone. It deliberately talks to a running server instead of the
 * SQLite file: the file belongs to whichever process has it open, and the API
 * is the only writer that keeps the transactional invariants intact.
 *
 *   npm run dev          # in one shell
 *   npm run db:seed-demo # in another
 */
const base = process.env.API_BASE_URL ?? "http://127.0.0.1:8080";
const GROUP_NAME = "Demo flat";
const PEOPLE = [
  { display_name: "Anil", email: "anil.demo@share.local" },
  { display_name: "Beena", email: "beena.demo@share.local" },
  { display_name: "Charan", email: "charan.demo@share.local" },
];
const MONTH = new Date().toISOString().slice(0, 7);

async function call(path, { method = "GET", body } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${payload?.message ?? text}`);
  }
  return payload;
}

async function findOrCreateUser(person) {
  const users = await call("/v1/users");
  const existing = users.find((user) => user.email === person.email);
  if (existing) return existing;
  return call("/v1/users", { method: "POST", body: person });
}

async function main() {
  await call("/healthz").catch(() => {
    throw new Error(`no API at ${base} — start it first with \`npm run dev\``);
  });

  const [anil, beena, charan] = await Promise.all(PEOPLE.map(findOrCreateUser));
  const groups = await call(`/v1/groups?user_id=${encodeURIComponent(anil.id)}`);
  const existingGroup = groups.find((group) => group.name === GROUP_NAME);
  if (existingGroup) {
    const balances = await call(`/v1/groups/${existingGroup.group_id}/balances`);
    console.log(`"${GROUP_NAME}" already exists with ${balances.balances.length} members; nothing seeded.`);
    console.log(`Open ${base}/ and pick ${PEOPLE.map((person) => person.display_name).join(", ")}.`);
    return;
  }

  const group = await call("/v1/groups", {
    method: "POST",
    body: {
      owner_user_id: anil.id,
      name: GROUP_NAME,
      description: "Shared groceries and the weekend bill",
      simplify_debts: true,
    },
  });
  const owner = group.owner_member_id;
  const [beenaMember, charanMember] = await Promise.all(
    [beena, charan].map(async (user) =>
      call(`/v1/groups/${group.id}/members`, {
        method: "POST",
        body: { actor_member_id: owner, user_id: user.id, role: "member" },
      }),
    ),
  );
  const beenaId = beenaMember.member_id;
  const charanId = charanMember.member_id;

  const expense = (payload) =>
    call(`/v1/groups/${group.id}/expenses`, {
      method: "POST",
      body: { actor_member_id: owner, expense_date: `${MONTH}-01`, ...payload },
    });

  await expense({
    description: "Groceries run",
    amount_paise: 240_100,
    category: "groceries",
    split_method: "equal",
    payer_member_id: owner,
    participant_member_ids: [owner, beenaId, charanId],
  });
  await expense({
    description: "Wifi bill",
    amount_paise: 12_000,
    category: "bills",
    split_method: "equal",
    payer_member_id: beenaId,
    participant_member_ids: [owner, beenaId, charanId],
  });
  await expense({
    description: "Fridge replacement",
    amount_paise: 90_000,
    category: "other",
    notes: "Anil paid the technician in cash",
    split_method: "exact",
    payer_member_id: charanId,
    exact_shares: [
      { member_id: owner, owed_paise: 45_000 },
      { member_id: beenaId, owed_paise: 30_000 },
      { member_id: charanId, owed_paise: 15_000 },
    ],
  });

  const balances = await call(`/v1/groups/${group.id}/balances`);
  const first = balances.suggested_transfers[0];
  if (first) {
    await call(`/v1/groups/${group.id}/settlements`, {
      method: "POST",
      body: {
        actor_member_id: owner,
        paid_by_member_id: first.from_member_id,
        received_by_member_id: first.to_member_id,
        amount_paise: first.amount_paise,
        settlement_date: `${MONTH}-02`,
        payment_method: "upi",
        notes: "Seeded so the ledger has both sides",
      },
    });
  }

  const after = await call(`/v1/groups/${group.id}/balances`);
  const rupees = (paise) => `₹${(paise / 100).toFixed(2)}`;
  console.log(`seeded "${GROUP_NAME}" (${group.id})`);
  for (const row of after.balances) {
    console.log(`  ${row.display_name.padEnd(8)} ${rupees(row.balance_paise).padStart(12)}`);
  }
  console.log(`suggested transfers left: ${after.suggested_transfers.length}`);
  console.log(`open ${base}/ and pick ${PEOPLE.map((person) => person.display_name).join(", ")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
