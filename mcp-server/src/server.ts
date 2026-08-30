import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SQLiteDatabase } from "../../src/db/database";
import { AccountService } from "../../src/services/accounts";
import { BalanceService } from "../../src/services/balance";
import { ExpenseService } from "../../src/services/expenses";
import { GroupService } from "../../src/services/groups";
import { SettlementService } from "../../src/services/settlements";
import {
  serializeBalanceResult,
  serializeExpense,
  serializeGroup,
  serializeMember,
  serializeMembershipGroup,
  serializeRosterMember,
  serializeSettlement,
  serializeUser,
  textResult,
} from "./format";

/** The same service composition the HTTP backend uses. */
export interface AppDependencies {
  database: SQLiteDatabase;
  accounts: AccountService;
  groups: GroupService;
  expenses: ExpenseService;
  balances: BalanceService;
  settlements: SettlementService;
}

export const SERVER_NAME = "share-mcp-server";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Share is a shared-expense tracker. All monetary amounts are integer paise (1 rupee = 100 paise).",
  "Every write requires actor_member_id: the member id of the person performing the action (the member, not the user).",
  "Suggested flow: list_users to pick a person, create_group, add_member for each participant, create_expense, then get_balances to see who owes whom, and create_settlement to record payments.",
  "Dates are ISO strings in the form YYYY-MM-DD.",
  "The data in this server is the source of truth for the Share app; writes are immediate and durable.",
].join(" ");

/** Build the MCP server over the existing Share backend services. */
export function createShareMcpServer(dependencies: AppDependencies): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_users",
    {
      title: "List users",
      description:
        "List all people registered in the Share app. Use this to find a user id before creating a group.",
      inputSchema: {},
    },
    async () => {
      const users = dependencies.accounts.listUsers();
      return textResult(users.map(serializeUser));
    },
  );

  server.registerTool(
    "create_user",
    {
      title: "Create user",
      description:
        "Register a new person in the Share app. Returns the created user with its id.",
      inputSchema: {
        email: z.string().describe("Email address; must be unique, lowercased"),
        display_name: z.string().describe("Name shown in balances and rosters"),
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone, defaults to Asia/Kolkata"),
      },
    },
    async (args) => {
      const user = dependencies.accounts.createUser({
        email: args.email,
        displayName: args.display_name,
        timezone: args.timezone,
      });
      return textResult(serializeUser(user));
    },
  );

  server.registerTool(
    "list_groups",
    {
      title: "List groups",
      description:
        "List the groups a user belongs to, with the caller's member id and role in each group.",
      inputSchema: {
        user_id: z.string().describe("User id returned by list_users"),
      },
    },
    async (args) => {
      const groups = dependencies.groups.listForUser(args.user_id);
      return textResult(groups.map(serializeMembershipGroup));
    },
  );

  server.registerTool(
    "create_group",
    {
      title: "Create group",
      description:
        "Create a new expense group owned by a user. The owner becomes the first member (role 'owner'); use its owner_member_id as actor_member_id for later actions.",
      inputSchema: {
        owner_user_id: z.string().describe("User id returned by list_users"),
        name: z.string().describe("Group name, e.g. 'Flat 4B groceries'"),
        description: z.string().optional(),
        simplify_debts: z
          .boolean()
          .optional()
          .describe("Minimize the number of suggested transfers; defaults to true"),
      },
    },
    async (args) => {
      const group = dependencies.groups.create({
        ownerUserId: args.owner_user_id,
        name: args.name,
        description: args.description,
        simplifyDebts: args.simplify_debts,
      });
      return textResult(serializeGroup(group));
    },
  );

  server.registerTool(
    "list_members",
    {
      title: "List group members",
      description:
        "List the roster of a group: member ids, user ids, display names, roles and statuses.",
      inputSchema: {
        group_id: z.string().describe("Group id returned by create_group or list_groups"),
      },
    },
    async (args) => {
      const members = dependencies.groups.listMembers(args.group_id);
      return textResult(members.map(serializeRosterMember));
    },
  );

  server.registerTool(
    "add_member",
    {
      title: "Add member to group",
      description:
        "Add an existing user to a group. actor_member_id must be an active member of the group; only the owner can add members.",
      inputSchema: {
        group_id: z.string(),
        actor_member_id: z
          .string()
          .describe("Member id of the person performing the action (the owner)"),
        user_id: z.string().describe("User id of the person being added"),
        role: z
          .enum(["owner", "admin", "member"])
          .optional()
          .describe("Role of the new member; defaults to 'member'"),
      },
    },
    async (args) => {
      const member = dependencies.groups.addMember({
        groupId: args.group_id,
        actorMemberId: args.actor_member_id,
        userId: args.user_id,
        role: args.role,
      });
      return textResult(serializeMember(member));
    },
  );

  server.registerTool(
    "list_expenses",
    {
      title: "List expenses",
      description:
        "List the expenses recorded in a group, newest first.",
      inputSchema: {
        group_id: z.string(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum number of expenses to return; defaults to 50"),
      },
    },
    async (args) => {
      const expenses = dependencies.expenses.list(args.group_id, args.limit ?? 50);
      return textResult(expenses.map(serializeExpense));
    },
  );

  server.registerTool(
    "create_expense",
    {
      title: "Create expense",
      description:
        "Record a new expense in a group with an equal or exact split. The payer is a group member; participant_member_ids default to all active members for equal splits. exact_shares must sum to amount_paise.",
      inputSchema: {
        group_id: z.string(),
        actor_member_id: z.string().describe("Member id of the person recording the expense"),
        description: z.string(),
        amount_paise: z
          .number()
          .int()
          .positive()
          .describe("Total amount in paise (1 rupee = 100 paise)"),
        expense_date: z.string().describe("Date of the expense, YYYY-MM-DD"),
        category: z.string().optional(),
        notes: z.string().optional(),
        split_method: z.enum(["equal", "exact"]),
        payer_member_id: z.string().describe("Member id of the person who paid"),
        participant_member_ids: z
          .array(z.string())
          .optional()
          .describe("Member ids sharing the cost; defaults to all active members"),
        exact_shares: z
          .array(
            z.object({
              member_id: z.string(),
              owed_paise: z.number().int().positive(),
            }),
          )
          .optional()
          .describe("Required when split_method is 'exact'; must sum to amount_paise"),
      },
    },
    async (args) => {
      const expense = dependencies.expenses.create({
        groupId: args.group_id,
        actorMemberId: args.actor_member_id,
        description: args.description,
        amountPaise: args.amount_paise,
        expenseDate: args.expense_date,
        category: args.category,
        notes: args.notes,
        splitMethod: args.split_method,
        payerMemberId: args.payer_member_id,
        participantMemberIds: args.participant_member_ids,
        exactShares: args.exact_shares?.map((share) => ({
          memberId: share.member_id,
          owedPaise: share.owed_paise,
        })),
      });
      return textResult(serializeExpense(expense));
    },
  );

  server.registerTool(
    "get_balances",
    {
      title: "Get group balances",
      description:
        "Compute who owes whom in a group. balance_paise is positive when the member is owed money and negative when they owe. suggested_transfers are the minimal settlement plan (only when simplify_debts is enabled).",
      inputSchema: {
        group_id: z.string(),
      },
    },
    async (args) => {
      const result = dependencies.balances.forGroup(args.group_id);
      return textResult(serializeBalanceResult(result));
    },
  );

  server.registerTool(
    "list_settlements",
    {
      title: "List settlements",
      description:
        "List the recorded payments (settlements) in a group, newest first.",
      inputSchema: {
        group_id: z.string(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum number of settlements to return; defaults to 50"),
      },
    },
    async (args) => {
      const settlements = dependencies.settlements.list(args.group_id, args.limit ?? 50);
      return textResult(settlements.map(serializeSettlement));
    },
  );

  server.registerTool(
    "create_settlement",
    {
      title: "Create settlement",
      description:
        "Record that one member paid another member to settle a balance. Use get_balances first to determine who should pay whom and how much.",
      inputSchema: {
        group_id: z.string(),
        actor_member_id: z.string().describe("Member id of the person recording the payment"),
        paid_by_member_id: z.string().describe("Member id of the person who paid"),
        received_by_member_id: z.string().describe("Member id of the person who received"),
        amount_paise: z
          .number()
          .int()
          .positive()
          .describe("Amount paid in paise (1 rupee = 100 paise)"),
        settlement_date: z.string().describe("Date of the payment, YYYY-MM-DD"),
        payment_method: z.enum(["upi", "cash", "bank_transfer", "other"]),
        notes: z.string().optional(),
      },
    },
    async (args) => {
      const settlement = dependencies.settlements.create({
        groupId: args.group_id,
        actorMemberId: args.actor_member_id,
        paidByMemberId: args.paid_by_member_id,
        receivedByMemberId: args.received_by_member_id,
        amountPaise: args.amount_paise,
        settlementDate: args.settlement_date,
        paymentMethod: args.payment_method,
        notes: args.notes,
      });
      return textResult(serializeSettlement(settlement));
    },
  );

  return server;
}
