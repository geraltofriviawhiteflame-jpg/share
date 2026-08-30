import { randomUUID } from "node:crypto";
import { SQLiteDatabase } from "../db/database";
import { Paise } from "../domain/types";
import { forbidden, notFound, validation } from "../domain/errors";

export interface ShareInput {
  memberId: string;
  owedPaise: Paise;
}

export interface CreateExpenseInput {
  groupId: string;
  actorMemberId: string;
  description: string;
  amountPaise: Paise;
  expenseDate: string;
  category?: string;
  notes?: string;
  splitMethod: "equal" | "exact";
  payerMemberId: string;
  participantMemberIds?: string[];
  exactShares?: ShareInput[];
}

export interface Share {
  memberId: string;
  owedPaise: Paise;
}

export interface Payer {
  memberId: string;
  amountPaise: Paise;
}

export interface Expense {
  id: string;
  groupId: string;
  description: string;
  amountPaise: Paise;
  currency: "INR";
  expenseDate: string;
  category?: string;
  notes?: string;
  splitMethod: "equal" | "exact";
  payer: Payer;
  shares: Share[];
  version: number;
}

type MemberRow = {
  status: string;
  archived_at: string | null;
};

type AllocationTotals = {
  amount_paise: number;
  paid_paise: number;
  owed_paise: number;
};

export class ExpenseService {
  public constructor(private readonly database: SQLiteDatabase) {}

  /**
   * Writes the expense, allocation rows, and audit event atomically. SQLite
   * CHECK constraints handle row-level rules; this service handles the
   * cross-row payer/share sum invariant.
   */
  public create(input: CreateExpenseInput): Expense {
    const normalized = normalizeInput(input);
    validateCreateInput(normalized);
    const shares = prepareShares(normalized);
    const expenseId = randomUUID();
    const eventId = randomUUID();

    const createExpense = this.database.transaction(() => {
      requireActiveMember(this.database, normalized.groupId, normalized.actorMemberId);
      requireActiveMember(this.database, normalized.groupId, normalized.payerMemberId);
      for (const share of shares) {
        requireActiveMember(this.database, normalized.groupId, share.memberId);
      }

      this.database
        .prepare(`
          INSERT INTO expenses (
            id, group_id, description, amount_paise, expense_date, category, notes,
            split_method, created_by_member_id, updated_by_member_id
          )
          VALUES (
            @id, @groupId, @description, @amountPaise, @expenseDate,
            NULLIF(@category, ''), NULLIF(@notes, ''), @splitMethod,
            @actorMemberId, @actorMemberId
          )
        `)
        .run({
          id: expenseId,
          groupId: normalized.groupId,
          description: normalized.description,
          amountPaise: normalized.amountPaise,
          expenseDate: normalized.expenseDate,
          category: normalized.category,
          notes: normalized.notes,
          splitMethod: normalized.splitMethod,
          actorMemberId: normalized.actorMemberId,
        });
      this.database
        .prepare(`
          INSERT INTO expense_payers (group_id, expense_id, member_id, amount_paise)
          VALUES (?, ?, ?, ?)
        `)
        .run(
          normalized.groupId,
          expenseId,
          normalized.payerMemberId,
          normalized.amountPaise,
        );
      const insertShare = this.database.prepare(`
        INSERT INTO expense_shares (group_id, expense_id, member_id, owed_paise)
        VALUES (?, ?, ?, ?)
      `);
      for (const share of shares) {
        insertShare.run(
          normalized.groupId,
          expenseId,
          share.memberId,
          share.owedPaise,
        );
      }

      const totals = this.database
        .prepare(`
          SELECT amount_paise, paid_paise, owed_paise
          FROM expense_allocation_totals
          WHERE group_id = ? AND expense_id = ?
        `)
        .get(normalized.groupId, expenseId) as AllocationTotals | undefined;
      if (
        !totals ||
        totals.amount_paise !== totals.paid_paise ||
        totals.amount_paise !== totals.owed_paise
      ) {
        throw validation("payer and share amounts must equal the expense amount");
      }

      const expense: Expense = {
        id: expenseId,
        groupId: normalized.groupId,
        description: normalized.description,
        amountPaise: normalized.amountPaise,
        currency: "INR",
        expenseDate: normalized.expenseDate,
        category: normalized.category || undefined,
        notes: normalized.notes || undefined,
        splitMethod: normalized.splitMethod,
        payer: {
          memberId: normalized.payerMemberId,
          amountPaise: normalized.amountPaise,
        },
        shares,
        version: 1,
      };
      this.database
        .prepare(`
          INSERT INTO activity_events (
            id, group_id, actor_member_id, entity_type, entity_id, action, after_json
          )
          VALUES (?, ?, ?, 'expense', ?, 'created', ?)
        `)
        .run(
          eventId,
          normalized.groupId,
          normalized.actorMemberId,
          expenseId,
          JSON.stringify(expense),
        );
      return expense;
    });

    return createExpense();
  }

  public list(groupId: string, limit = 50): Expense[] {
    const normalizedGroupId = groupId.trim();
    if (!normalizedGroupId) {
      throw validation("group id is required");
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      limit = 50;
    }
    const group = this.database
      .prepare(`SELECT 1 AS value FROM groups WHERE id = ?`)
      .get(normalizedGroupId) as { value: number } | undefined;
    if (!group) {
      throw notFound("group was not found");
    }

    const rows = this.database
      .prepare(`
        SELECT id, group_id, description, amount_paise, currency, expense_date,
               category, notes, split_method, version
        FROM expenses
        WHERE group_id = ? AND deleted_at IS NULL
        ORDER BY expense_date DESC, created_at DESC, id DESC
        LIMIT ?
      `)
      .all(normalizedGroupId, limit) as Array<{
      id: string;
      group_id: string;
      description: string;
      amount_paise: number;
      currency: "INR";
      expense_date: string;
      category: string | null;
      notes: string | null;
      split_method: "equal" | "exact";
      version: number;
    }>;

    return rows.map((row) => {
      const payer = this.database
        .prepare(`
          SELECT member_id, amount_paise
          FROM expense_payers
          WHERE group_id = ? AND expense_id = ?
          ORDER BY member_id
          LIMIT 1
        `)
        .get(row.group_id, row.id) as
        | { member_id: string; amount_paise: number }
        | undefined;
      if (!payer) {
        throw new Error(`expense ${row.id} has no payer allocation`);
      }
      const shares = this.database
        .prepare(`
          SELECT member_id, owed_paise
          FROM expense_shares
          WHERE group_id = ? AND expense_id = ?
          ORDER BY member_id
        `)
        .all(row.group_id, row.id) as Array<{
        member_id: string;
        owed_paise: number;
      }>;
      return {
        id: row.id,
        groupId: row.group_id,
        description: row.description,
        amountPaise: row.amount_paise,
        currency: row.currency,
        expenseDate: row.expense_date,
        category: row.category ?? undefined,
        notes: row.notes ?? undefined,
        splitMethod: row.split_method,
        payer: {
          memberId: payer.member_id,
          amountPaise: payer.amount_paise,
        },
        shares: shares.map((share) => ({
          memberId: share.member_id,
          owedPaise: share.owed_paise,
        })),
        version: row.version,
      } satisfies Expense;
    });
  }
}

function normalizeInput(input: CreateExpenseInput): CreateExpenseInput {
  return {
    ...input,
    groupId: input.groupId.trim(),
    actorMemberId: input.actorMemberId.trim(),
    description: input.description.trim(),
    expenseDate: input.expenseDate.trim(),
    category: input.category?.trim() || "",
    notes: input.notes?.trim() || "",
    payerMemberId: input.payerMemberId.trim(),
    splitMethod: input.splitMethod,
  };
}

function validateCreateInput(input: CreateExpenseInput): void {
  if (!input.groupId || !input.actorMemberId) {
    throw validation("group_id and actor_member_id are required");
  }
  if (!input.description) {
    throw validation("description is required");
  }
  if (!isSafePositiveInteger(input.amountPaise)) {
    throw validation("amount_paise must be a positive integer");
  }
  if (!isDate(input.expenseDate)) {
    throw validation("expense_date must be a valid YYYY-MM-DD date");
  }
  if (!input.payerMemberId) {
    throw validation("payer_member_id is required");
  }
  if (input.splitMethod !== "equal" && input.splitMethod !== "exact") {
    throw validation("split_method must be equal or exact");
  }
}

/** Exported for table-driven unit tests and interview discussion. */
export function prepareShares(input: CreateExpenseInput): Share[] {
  if (input.splitMethod === "exact") {
    const exactShares = input.exactShares ?? [];
    if (!exactShares.length) {
      throw validation("exact split requires at least one share");
    }
    const seen = new Set<string>();
    let total = 0;
    const shares: Share[] = [];
    for (const candidate of exactShares) {
      const memberId = candidate.memberId.trim();
      if (!memberId) {
        throw validation("each share requires member_id");
      }
      if (!isSafePositiveInteger(candidate.owedPaise)) {
        throw validation("share owed_paise must be a positive integer");
      }
      if (seen.has(memberId)) {
        throw validation("a participant cannot appear twice");
      }
      seen.add(memberId);
      total += candidate.owedPaise;
      if (!Number.isSafeInteger(total) || total > input.amountPaise) {
        throw validation("exact shares exceed the expense amount");
      }
      shares.push({ memberId, owedPaise: candidate.owedPaise });
    }
    if (total !== input.amountPaise) {
      throw validation("exact shares must sum to amount_paise");
    }
    return shares;
  }

  const participantIds = input.participantMemberIds ?? [];
  if (!participantIds.length) {
    throw validation("equal split requires participant_member_ids");
  }
  const members = participantIds.map((memberId) => memberId.trim());
  if (members.some((memberId) => !memberId)) {
    throw validation("participant_member_ids cannot contain an empty id");
  }
  if (new Set(members).size !== members.length) {
    throw validation("a participant cannot appear twice");
  }
  if (input.amountPaise < members.length) {
    throw validation("amount_paise must be at least one paise per participant");
  }

  members.sort();
  const base = Math.floor(input.amountPaise / members.length);
  const remainder = input.amountPaise % members.length;
  return members.map((memberId, index) => ({
    memberId,
    owedPaise: base + (index < remainder ? 1 : 0),
  }));
}

function requireActiveMember(
  database: SQLiteDatabase,
  groupId: string,
  memberId: string,
): void {
  const row = database
    .prepare(`
      SELECT gm.status, g.archived_at
      FROM group_members AS gm
      JOIN groups AS g ON g.id = gm.group_id
      WHERE gm.group_id = ? AND gm.id = ?
    `)
    .get(groupId, memberId) as MemberRow | undefined;
  if (!row) {
    throw notFound("group member was not found");
  }
  if (row.status !== "active") {
    throw forbidden("group member is not active");
  }
  if (row.archived_at) {
    throw forbidden("group is archived");
  }
}

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
