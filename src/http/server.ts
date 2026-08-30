import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { getAbsoluteFSPath } from "swagger-ui-dist";
import { AccountService } from "../services/accounts";
import { BalanceService } from "../services/balance";
import { ExpenseService } from "../services/expenses";
import { GroupService } from "../services/groups";
import { SettlementService } from "../services/settlements";
import type { User } from "../services/accounts";
import type {
  BalanceResult,
  MemberBalance,
  SuggestedTransfer,
} from "../services/balance";
import type { Expense, Payer, Share } from "../services/expenses";
import type { Group, Member, MembershipGroup, RosterMember } from "../services/groups";
import type { Settlement } from "../services/settlements";
import { DomainError, notFound, validation } from "../domain/errors";
import { SQLiteDatabase } from "../db/database";
import { isUiPath, serveUiAsset } from "./ui";
import { openApiDocument } from "./openapi";

export interface AppDependencies {
  database: SQLiteDatabase;
  accounts: AccountService;
  groups: GroupService;
  expenses: ExpenseService;
  balances: BalanceService;
  settlements: SettlementService;
}

const maxBodyBytes = 1 << 20;

export function createHandler(dependencies: AppDependencies): RequestListener {
  return (request, response) => {
    void handleRequest(request, response, dependencies).catch((error: unknown) => {
      if (!response.headersSent) {
        writeError(response, error);
      } else {
        response.destroy();
      }
    });
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: AppDependencies,
): Promise<void> {
  const requestId = request.headers["x-request-id"]?.toString() || randomUUID();
  response.setHeader("X-Request-ID", requestId);

  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/docs" || url.pathname === "/docs/") {
    if (request.method !== "GET") {
      return methodNotAllowed(response, "GET");
    }
    return writeHtml(response, swaggerUiHtml());
  }
  if (url.pathname.startsWith("/docs/")) {
    if (request.method !== "GET") {
      return methodNotAllowed(response, "GET");
    }
    return serveSwaggerAsset(response, url.pathname.slice("/docs/".length));
  }
  if (url.pathname === "/openapi.json") {
    if (request.method !== "GET") {
      return methodNotAllowed(response, "GET");
    }
    return writeJson(response, 200, openApiDocument);
  }

  if (url.pathname === "/healthz") {
    if (request.method !== "GET") {
      return methodNotAllowed(response, "GET");
    }
    dependencies.database.prepare("SELECT 1").get();
    return writeJson(response, 200, { status: "ok" });
  }

  if (isUiPath(url.pathname)) {
    if (request.method !== "GET") {
      return methodNotAllowed(response, "GET");
    }
    return serveUiAsset(response, url.pathname);
  }

  if (parts.length === 2 && parts[0] === "v1" && parts[1] === "users") {
    if (request.method === "GET") {
      return writeJson(
        response,
        200,
        dependencies.accounts.listUsers().map(serializeUser),
      );
    }
    if (request.method !== "POST") {
      return methodNotAllowed(response, "GET", "POST");
    }
    const body = await readObject(request);
    const user = dependencies.accounts.createUser({
      email: requiredString(body, "email"),
      displayName: requiredString(body, "display_name"),
      timezone: optionalString(body, "timezone"),
    });
    return writeJson(response, 201, serializeUser(user));
  }

  if (parts.length === 2 && parts[0] === "v1" && parts[1] === "groups") {
    if (request.method === "GET") {
      const userId = url.searchParams.get("user_id") ?? "";
      return writeJson(
        response,
        200,
        dependencies.groups.listForUser(userId).map(serializeMembershipGroup),
      );
    }
    if (request.method !== "POST") {
      return methodNotAllowed(response, "GET", "POST");
    }
    const body = await readObject(request);
    const group = dependencies.groups.create({
      ownerUserId: requiredString(body, "owner_user_id"),
      name: requiredString(body, "name"),
      description: optionalString(body, "description"),
      simplifyDebts: optionalBoolean(body, "simplify_debts"),
    });
    return writeJson(response, 201, serializeGroup(group));
  }

  if (
    parts.length === 3 &&
    parts[0] === "v1" &&
    parts[1] === "groups" &&
    parts[2]
  ) {
    return writeError(response, notFound("resource was not found"));
  }

  if (parts.length !== 4 || parts[0] !== "v1" || parts[1] !== "groups") {
    return writeError(response, notFound("resource was not found"));
  }

  const groupId = parts[2];
  const resource = parts[3];
  switch (resource) {
    case "members": {
      if (request.method === "GET") {
        return writeJson(
          response,
          200,
          dependencies.groups.listMembers(groupId).map(serializeRosterMember),
        );
      }
      if (request.method !== "POST") {
        return methodNotAllowed(response, "GET", "POST");
      }
      const body = await readObject(request);
      const member = dependencies.groups.addMember({
        groupId,
        actorMemberId: requiredString(body, "actor_member_id"),
        userId: requiredString(body, "user_id"),
        role: optionalString(body, "role"),
      });
      return writeJson(response, 201, serializeMember(member));
    }
    case "expenses": {
      if (request.method === "GET") {
        return writeJson(
          response,
          200,
          dependencies.expenses.list(groupId, queryLimit(url)).map(serializeExpense),
        );
      }
      if (request.method !== "POST") {
        return methodNotAllowed(response, "GET", "POST");
      }
      const body = await readObject(request);
      const splitMethod = requiredString(body, "split_method");
      const expense = dependencies.expenses.create({
        groupId,
        actorMemberId: requiredString(body, "actor_member_id"),
        description: requiredString(body, "description"),
        amountPaise: requiredInteger(body, "amount_paise"),
        expenseDate: requiredString(body, "expense_date"),
        category: optionalString(body, "category"),
        notes: optionalString(body, "notes"),
        splitMethod: splitMethod as "equal" | "exact",
        payerMemberId: requiredString(body, "payer_member_id"),
        participantMemberIds: optionalStringArray(body, "participant_member_ids"),
        exactShares: optionalShares(body, "exact_shares"),
      });
      return writeJson(response, 201, serializeExpense(expense));
    }
    case "balances":
      if (request.method !== "GET") {
        return methodNotAllowed(response, "GET");
      }
      return writeJson(
        response,
        200,
        serializeBalanceResult(dependencies.balances.forGroup(groupId)),
      );
    case "settlements": {
      if (request.method === "GET") {
        return writeJson(
          response,
          200,
          dependencies.settlements
            .list(groupId, queryLimit(url))
            .map(serializeSettlement),
        );
      }
      if (request.method !== "POST") {
        return methodNotAllowed(response, "GET", "POST");
      }
      const body = await readObject(request);
      const paymentMethod = requiredString(body, "payment_method");
      const settlement = dependencies.settlements.create({
        groupId,
        actorMemberId: requiredString(body, "actor_member_id"),
        paidByMemberId: requiredString(body, "paid_by_member_id"),
        receivedByMemberId: requiredString(body, "received_by_member_id"),
        amountPaise: requiredInteger(body, "amount_paise"),
        settlementDate: requiredString(body, "settlement_date"),
        paymentMethod: paymentMethod as
          | "upi"
          | "cash"
          | "bank_transfer"
          | "other",
        notes: optionalString(body, "notes"),
      });
      return writeJson(response, 201, serializeSettlement(settlement));
    }
    default:
      return writeError(response, notFound("resource was not found"));
  }
}

async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) {
      throw validation("request body must be smaller than 1 MiB");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) {
    throw validation("request body must be valid JSON");
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw validation(`request body must be valid JSON: ${String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validation("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw validation(`${field} is required`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw validation(`${field} must be a string`);
  }
  return value;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw validation(`${field} must be a boolean`);
  }
  return value;
}

function requiredInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw validation(`${field} must be a safe integer`);
  }
  return value;
}

function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw validation(`${field} must be an array of strings`);
  }
  return value as string[];
}

function optionalShares(
  body: Record<string, unknown>,
  field: string,
): Array<{ memberId: string; owedPaise: number }> | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw validation(`${field} must be an array`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw validation(`${field}[${index}] must be an object`);
    }
    const share = item as Record<string, unknown>;
    return {
      memberId: requiredString(share, "member_id"),
      owedPaise: requiredInteger(share, "owed_paise"),
    };
  });
}

const swaggerAssetMap: Record<string, { file: string; contentType: string }> = {
  "swagger-ui.css": {
    file: "swagger-ui.css",
    contentType: "text/css; charset=utf-8",
  },
  "swagger-ui-bundle.js": {
    file: "swagger-ui-bundle.js",
    contentType: "application/javascript; charset=utf-8",
  },
  "swagger-ui-standalone-preset.js": {
    file: "swagger-ui-standalone-preset.js",
    contentType: "application/javascript; charset=utf-8",
  },
};

function swaggerUiHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Share Expense Tracker API</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script src="/docs/swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = () => {
        window.ui = SwaggerUIBundle({
          url: "/openapi.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: "StandaloneLayout",
        });
      };
    </script>
  </body>
</html>`;
}

function serveSwaggerAsset(response: ServerResponse, assetName: string): void {
  const asset = swaggerAssetMap[assetName];
  if (!asset) {
    return writeError(response, notFound("documentation asset was not found"));
  }
  try {
    const content = readFileSync(join(getAbsoluteFSPath(), asset.file));
    response.statusCode = 200;
    response.setHeader("Content-Type", asset.contentType);
    response.end(content);
  } catch (error) {
    writeError(response, error);
  }
}

function writeHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}

function serializeUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    timezone: user.timezone,
  };
}

function serializeGroup(group: Group) {
  return {
    id: group.id,
    name: group.name,
    ...(group.description ? { description: group.description } : {}),
    owner_user_id: group.ownerUserId,
    owner_member_id: group.ownerMemberId,
    simplify_debts: group.simplifyDebts,
  };
}

function serializeMembershipGroup(group: MembershipGroup) {
  return {
    group_id: group.groupId,
    name: group.name,
    role: group.role,
    member_id: group.memberId,
    simplify_debts: group.simplifyDebts,
  };
}

function serializeMember(member: Member) {
  return {
    member_id: member.memberId,
    group_id: member.groupId,
    user_id: member.userId,
    role: member.role,
    status: member.status,
  };
}

/** Shared `?limit=` parsing; the services clamp out-of-range page sizes. */
function queryLimit(url: URL): number {
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit === null) {
    return 50;
  }
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit)) {
    throw validation("limit must be an integer");
  }
  return limit;
}

function serializeRosterMember(member: RosterMember) {
  return {
    member_id: member.memberId,
    group_id: member.groupId,
    user_id: member.userId,
    display_name: member.displayName,
    role: member.role,
    status: member.status,
  };
}

function serializePayer(payer: Payer) {
  return {
    member_id: payer.memberId,
    amount_paise: payer.amountPaise,
  };
}

function serializeShare(share: Share) {
  return {
    member_id: share.memberId,
    owed_paise: share.owedPaise,
  };
}

function serializeExpense(expense: Expense) {
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

function serializeMemberBalance(balance: MemberBalance) {
  return {
    member_id: balance.memberId,
    user_id: balance.userId,
    display_name: balance.displayName,
    status: balance.status,
    balance_paise: balance.balancePaise,
  };
}

function serializeSuggestedTransfer(transfer: SuggestedTransfer) {
  return {
    from_member_id: transfer.fromMemberId,
    to_member_id: transfer.toMemberId,
    amount_paise: transfer.amountPaise,
  };
}

function serializeBalanceResult(result: BalanceResult) {
  return {
    group_id: result.groupId,
    balances: result.balances.map(serializeMemberBalance),
    suggested_transfers: result.suggestedTransfers.map(serializeSuggestedTransfer),
    total_paise: result.totalPaise,
  };
}

function serializeSettlement(settlement: Settlement) {
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

function methodNotAllowed(response: ServerResponse, ...methods: string[]): void {
  response.setHeader("Allow", methods.join(", "));
  writeJson(response, 405, {
    error: "Method Not Allowed",
    message: `method not allowed; use ${methods.join(" or ")}`,
  });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function writeError(response: ServerResponse, error: unknown): void {
  let status = 500;
  let message = "internal server error";
  if (error instanceof DomainError) {
    message = error.message;
    status = {
      validation: 400,
      not_found: 404,
      conflict: 409,
      forbidden: 403,
      unavailable: 503,
    }[error.kind];
  }
  if (status >= 500) {
    console.error(error);
  }
  writeJson(response, status, {
    error: statusText(status),
    message,
  });
}

function statusText(status: number): string {
  return (
    {
      400: "Bad Request",
      403: "Forbidden",
      404: "Not Found",
      405: "Method Not Allowed",
      409: "Conflict",
      503: "Service Unavailable",
      500: "Internal Server Error",
    }[status] ?? "Error"
  );
}
