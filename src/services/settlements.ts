import { randomUUID } from "node:crypto";
import { SQLiteDatabase } from "../db/database";
import { forbidden, notFound, validation } from "../domain/errors";
import { Paise } from "../domain/types";

export interface CreateSettlementInput {
  groupId: string;
  actorMemberId: string;
  paidByMemberId: string;
  receivedByMemberId: string;
  amountPaise: Paise;
  settlementDate: string;
  paymentMethod: "upi" | "cash" | "bank_transfer" | "other";
  notes?: string;
}

export interface Settlement {
  id: string;
  groupId: string;
  paidByMemberId: string;
  receivedByMemberId: string;
  amountPaise: Paise;
  currency: "INR";
  settlementDate: string;
  paymentMethod: CreateSettlementInput["paymentMethod"];
  notes?: string;
  version: number;
}

type MemberRow = {
  role: string;
  status: string;
  archived_at: string | null;
};

export class SettlementService {
  public constructor(private readonly database: SQLiteDatabase) {}

  public create(input: CreateSettlementInput): Settlement {
    const normalized = {
      ...input,
      groupId: input.groupId.trim(),
      actorMemberId: input.actorMemberId.trim(),
      paidByMemberId: input.paidByMemberId.trim(),
      receivedByMemberId: input.receivedByMemberId.trim(),
      settlementDate: input.settlementDate.trim(),
      notes: input.notes?.trim() || "",
    };
    validateInput(normalized);

    const settlement: Settlement = {
      id: randomUUID(),
      groupId: normalized.groupId,
      paidByMemberId: normalized.paidByMemberId,
      receivedByMemberId: normalized.receivedByMemberId,
      amountPaise: normalized.amountPaise,
      currency: "INR",
      settlementDate: normalized.settlementDate,
      paymentMethod: normalized.paymentMethod,
      notes: normalized.notes || undefined,
      version: 1,
    };
    const eventId = randomUUID();

    const createSettlement = this.database.transaction(() => {
      const actor = this.database
        .prepare(`
          SELECT gm.role, gm.status, g.archived_at
          FROM group_members AS gm
          JOIN groups AS g ON g.id = gm.group_id
          WHERE gm.group_id = ? AND gm.id = ?
        `)
        .get(normalized.groupId, normalized.actorMemberId) as MemberRow | undefined;
      if (!actor) {
        throw notFound("group member was not found");
      }
      if (actor.status !== "active" || actor.archived_at) {
        throw forbidden("settlement actor is not active");
      }

      for (const memberId of [
        normalized.paidByMemberId,
        normalized.receivedByMemberId,
      ]) {
        const member = this.database
          .prepare(`
            SELECT gm.role, gm.status, g.archived_at
            FROM group_members AS gm
            JOIN groups AS g ON g.id = gm.group_id
            WHERE gm.group_id = ? AND gm.id = ?
          `)
          .get(normalized.groupId, memberId) as MemberRow | undefined;
        if (!member) {
          throw notFound("settlement participant was not found");
        }
        if (member.status !== "active" || member.archived_at) {
          throw forbidden("settlement participant is not active");
        }
      }

      const isAdmin = actor.role === "owner" || actor.role === "admin";
      const isParticipant =
        normalized.actorMemberId === normalized.paidByMemberId ||
        normalized.actorMemberId === normalized.receivedByMemberId;
      if (!isAdmin && !isParticipant) {
        throw forbidden("settlement actor must be a participant");
      }

      this.database
        .prepare(`
          INSERT INTO settlements (
            id, group_id, paid_by_member_id, received_by_member_id, amount_paise,
            settlement_date, payment_method, notes, created_by_member_id,
            updated_by_member_id
          )
          VALUES (
            @id, @groupId, @paidByMemberId, @receivedByMemberId, @amountPaise,
            @settlementDate, @paymentMethod, NULLIF(@notes, ''),
            @actorMemberId, @actorMemberId
          )
        `)
        .run({
          id: settlement.id,
          groupId: settlement.groupId,
          paidByMemberId: settlement.paidByMemberId,
          receivedByMemberId: settlement.receivedByMemberId,
          amountPaise: settlement.amountPaise,
          settlementDate: settlement.settlementDate,
          paymentMethod: settlement.paymentMethod,
          notes: normalized.notes,
          actorMemberId: normalized.actorMemberId,
        });
      this.database
        .prepare(`
          INSERT INTO activity_events (
            id, group_id, actor_member_id, entity_type, entity_id, action, after_json
          )
          VALUES (?, ?, ?, 'settlement', ?, 'created', ?)
        `)
        .run(
          eventId,
          settlement.groupId,
          normalized.actorMemberId,
          settlement.id,
          JSON.stringify(settlement),
        );
      return settlement;
    });

    return createSettlement();
  }

  /** Active settlement records, newest first, for the group ledger view. */
  public list(groupId: string, limit = 50): Settlement[] {
    const normalizedGroupId = groupId.trim();
    if (!normalizedGroupId) {
      throw validation("group id is required");
    }
    let pageSize = limit;
    if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > 100) {
      pageSize = 50;
    }
    const group = this.database
      .prepare(`SELECT 1 AS value FROM groups WHERE id = ?`)
      .get(normalizedGroupId) as { value: number } | undefined;
    if (!group) {
      throw notFound("group was not found");
    }

    const rows = this.database
      .prepare(`
        SELECT id, group_id, paid_by_member_id, received_by_member_id,
               amount_paise, currency, settlement_date, payment_method, notes, version
        FROM settlements
        WHERE group_id = ? AND deleted_at IS NULL
        ORDER BY settlement_date DESC, created_at DESC, id DESC
        LIMIT ?
      `)
      .all(normalizedGroupId, pageSize) as Array<{
      id: string;
      group_id: string;
      paid_by_member_id: string;
      received_by_member_id: string;
      amount_paise: number;
      currency: "INR";
      settlement_date: string;
      payment_method: CreateSettlementInput["paymentMethod"];
      notes: string | null;
      version: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      groupId: row.group_id,
      paidByMemberId: row.paid_by_member_id,
      receivedByMemberId: row.received_by_member_id,
      amountPaise: row.amount_paise,
      currency: row.currency,
      settlementDate: row.settlement_date,
      paymentMethod: row.payment_method,
      notes: row.notes ?? undefined,
      version: row.version,
    }));
  }
}

function validateInput(input: CreateSettlementInput): void {
  if (!input.groupId || !input.actorMemberId) {
    throw validation("group_id and actor_member_id are required");
  }
  if (!input.paidByMemberId || !input.receivedByMemberId) {
    throw validation("both settlement participants are required");
  }
  if (input.paidByMemberId === input.receivedByMemberId) {
    throw validation("settlement participants must be different");
  }
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw validation("amount_paise must be a positive integer");
  }
  if (!isDate(input.settlementDate)) {
    throw validation("settlement_date must be a valid YYYY-MM-DD date");
  }
  if (!["upi", "cash", "bank_transfer", "other"].includes(input.paymentMethod)) {
    throw validation("payment_method must be upi, cash, bank_transfer, or other");
  }
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
