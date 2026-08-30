import type { User } from "../../src/services/accounts";
import type { Expense, Payer, Share } from "../../src/services/expenses";
import type {
  Group,
  Member,
  MembershipGroup,
  RosterMember,
} from "../../src/services/groups";
import type {
  BalanceResult,
  MemberBalance,
  SuggestedTransfer,
} from "../../src/services/balance";
import type { Settlement } from "../../src/services/settlements";

/** Minimal text-only tool result, which every tool in this server returns. */
export type TextToolResult = {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
};

/** Serialize any value as pretty-printed JSON in a text tool result. */
export function textResult(value: unknown): TextToolResult {
  return {
    content: [{ type: "text", text: `${JSON.stringify(value, null, 2)}\n` }],
  };
}

/**
 * The MCP tools return the same snake_case shapes as the HTTP API, so an
 * agent's understanding of the REST endpoints carries over to the tools.
 */

export function serializeUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    timezone: user.timezone,
  };
}

export function serializeGroup(group: Group) {
  return {
    id: group.id,
    name: group.name,
    ...(group.description ? { description: group.description } : {}),
    owner_user_id: group.ownerUserId,
    owner_member_id: group.ownerMemberId,
    simplify_debts: group.simplifyDebts,
  };
}

export function serializeMembershipGroup(group: MembershipGroup) {
  return {
    group_id: group.groupId,
    name: group.name,
    role: group.role,
    member_id: group.memberId,
    simplify_debts: group.simplifyDebts,
  };
}

export function serializeMember(member: Member) {
  return {
    member_id: member.memberId,
    group_id: member.groupId,
    user_id: member.userId,
    role: member.role,
    status: member.status,
  };
}

export function serializeRosterMember(member: RosterMember) {
  return {
    member_id: member.memberId,
    group_id: member.groupId,
    user_id: member.userId,
    display_name: member.displayName,
    role: member.role,
    status: member.status,
  };
}

export function serializePayer(payer: Payer) {
  return {
    member_id: payer.memberId,
    amount_paise: payer.amountPaise,
  };
}

export function serializeShare(share: Share) {
  return {
    member_id: share.memberId,
    owed_paise: share.owedPaise,
  };
}

export function serializeExpense(expense: Expense) {
  return {
    id: expense.id,
    group_id: expense.groupId,
    description: expense.description,
    amount_paise: expense.amountPaise,
    currency: expense.currency,
    expense_date: expense.expenseDate,
    ...(expense.category ? { category: expense.category } : {}),
    ...(expense.notes ? { notes: expense.notes } : {}),
    split_method: expense.splitMethod,
    payer: serializePayer(expense.payer),
    shares: expense.shares.map(serializeShare),
    version: expense.version,
  };
}

export function serializeMemberBalance(balance: MemberBalance) {
  return {
    member_id: balance.memberId,
    user_id: balance.userId,
    display_name: balance.displayName,
    status: balance.status,
    balance_paise: balance.balancePaise,
  };
}

export function serializeSuggestedTransfer(transfer: SuggestedTransfer) {
  return {
    from_member_id: transfer.fromMemberId,
    to_member_id: transfer.toMemberId,
    amount_paise: transfer.amountPaise,
  };
}

export function serializeBalanceResult(result: BalanceResult) {
  return {
    group_id: result.groupId,
    balances: result.balances.map(serializeMemberBalance),
    suggested_transfers: result.suggestedTransfers.map(
      serializeSuggestedTransfer,
    ),
    total_paise: result.totalPaise,
  };
}

export function serializeSettlement(settlement: Settlement) {
  return {
    id: settlement.id,
    group_id: settlement.groupId,
    paid_by_member_id: settlement.paidByMemberId,
    received_by_member_id: settlement.receivedByMemberId,
    amount_paise: settlement.amountPaise,
    currency: settlement.currency,
    settlement_date: settlement.settlementDate,
    payment_method: settlement.paymentMethod,
    ...(settlement.notes ? { notes: settlement.notes } : {}),
    version: settlement.version,
  };
}
