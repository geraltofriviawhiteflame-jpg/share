import { SQLiteDatabase } from "../db/database";
import { notFound, validation } from "../domain/errors";
import { Balance } from "../domain/types";

export interface MemberBalance {
  memberId: string;
  userId: string;
  displayName: string;
  status: string;
  balancePaise: number;
}

export interface SuggestedTransfer {
  fromMemberId: string;
  toMemberId: string;
  amountPaise: number;
}

export interface BalanceResult {
  groupId: string;
  balances: MemberBalance[];
  suggestedTransfers: SuggestedTransfer[];
  totalPaise: number;
}

export class BalanceService {
  public constructor(private readonly database: SQLiteDatabase) {}

  public forGroup(groupId: string): BalanceResult {
    const normalizedGroupId = groupId.trim();
    if (!normalizedGroupId) {
      throw validation("group id is required");
    }
    const group = this.database
      .prepare(`SELECT 1 AS value FROM groups WHERE id = ?`)
      .get(normalizedGroupId) as { value: number } | undefined;
    if (!group) {
      throw notFound("group was not found");
    }

    const rows = this.database
      .prepare(`
        SELECT b.member_id, b.user_id, u.display_name, gm.status, b.balance_paise
        FROM group_member_balances AS b
        JOIN group_members AS gm
          ON gm.group_id = b.group_id AND gm.id = b.member_id
        JOIN users AS u ON u.id = b.user_id
        WHERE b.group_id = ?
        ORDER BY b.member_id
      `)
      .all(normalizedGroupId) as Array<{
      member_id: string;
      user_id: string;
      display_name: string;
      status: string;
      balance_paise: number;
    }>;

    const balances = rows.map((row) => ({
      memberId: row.member_id,
      userId: row.user_id,
      displayName: row.display_name,
      status: row.status,
      balancePaise: row.balance_paise,
    }));
    const pureBalances = balances.map((item) => ({
      memberId: item.memberId,
      amountPaise: item.balancePaise,
    }));
    const suggestedTransfers = suggestTransfers(pureBalances);
    return {
      groupId: normalizedGroupId,
      balances,
      suggestedTransfers,
      totalPaise: pureBalances.reduce((sum, item) => sum + item.amountPaise, 0),
    };
  }
}

/**
 * Matches debtors and creditors using integer paise. Sorting by member ID
 * produces stable output for clients and tests. Suggestions are not settlement
 * records; recording a settlement naturally changes the next calculation.
 */
export function suggestTransfers(balances: Balance[]): SuggestedTransfer[] {
  const creditors = balances
    .filter((item) => item.amountPaise > 0)
    .map((item) => ({ ...item }))
    .sort((left, right) => compareIds(left.memberId, right.memberId));
  const debtors = balances
    .filter((item) => item.amountPaise < 0)
    .map((item) => {
      if (item.amountPaise === Number.MIN_SAFE_INTEGER) {
        throw validation("balance is outside the supported integer range");
      }
      return { ...item, amountPaise: -item.amountPaise };
    })
    .sort((left, right) => compareIds(left.memberId, right.memberId));

  const total = balances.reduce((sum, item) => sum + item.amountPaise, 0);
  if (!Number.isSafeInteger(total) || total !== 0) {
    throw validation("group balances do not sum to zero");
  }

  const transfers: SuggestedTransfer[] = [];
  let creditorIndex = 0;
  let debtorIndex = 0;
  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const amount = Math.min(
      creditors[creditorIndex].amountPaise,
      debtors[debtorIndex].amountPaise,
    );
    transfers.push({
      fromMemberId: debtors[debtorIndex].memberId,
      toMemberId: creditors[creditorIndex].memberId,
      amountPaise: amount,
    });
    creditors[creditorIndex].amountPaise -= amount;
    debtors[debtorIndex].amountPaise -= amount;
    if (creditors[creditorIndex].amountPaise === 0) {
      creditorIndex += 1;
    }
    if (debtors[debtorIndex].amountPaise === 0) {
      debtorIndex += 1;
    }
  }
  return transfers;
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
