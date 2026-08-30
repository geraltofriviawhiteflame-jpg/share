/**
 * The API contract is kept beside the HTTP adapter so the interactive docs and
 * the implementation evolve together. This is intentionally plain data rather
 * than a decorator-heavy framework: it is easy to read during an interview.
 */
export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Share Expense Tracker API",
    version: "0.1.0",
    description:
      "A learning API for shared expenses, derived balances, and external settlements. Authentication is intentionally the next milestone; the current examples use actor and member IDs.",
  },
  servers: [{ url: "/", description: "Current server" }],
  tags: [
    { name: "System", description: "Health and API discovery" },
    { name: "Accounts", description: "Temporary account bootstrap" },
    { name: "Groups", description: "Groups and memberships" },
    { name: "Expenses", description: "Transactional expense allocations" },
    { name: "Balances", description: "Derived balances and suggestions" },
    { name: "Settlements", description: "External settlement records" },
  ],
  paths: {
    "/healthz": {
      get: {
        tags: ["System"],
        summary: "Check API and database readiness",
        responses: {
          "200": {
            description: "Database is ready",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
          },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["System"],
        summary: "Get the OpenAPI document",
        responses: {
          "200": {
            description: "OpenAPI document",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/v1/users": {
      post: {
        tags: ["Accounts"],
        summary: "Create a temporary local user",
        description:
          "Bootstrap-only endpoint. Production account creation belongs to authentication and email verification.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateUserRequest" },
              example: {
                email: "anil@example.com",
                display_name: "Anil",
                timezone: "Asia/Kolkata",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "User created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/v1/groups": {
      get: {
        tags: ["Groups"],
        summary: "List active groups for a user",
        parameters: [
          {
            name: "user_id",
            in: "query",
            required: true,
            schema: { type: "string" },
            example: "user-id-from-create-user",
          },
        ],
        responses: {
          "200": {
            description: "Groups",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/MembershipGroup" } },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
      post: {
        tags: ["Groups"],
        summary: "Create a group and its owner atomically",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateGroupRequest" },
              example: {
                owner_user_id: "user-id-from-create-user",
                name: "Weekend trip",
                description: "Expenses for the Coorg trip",
                simplify_debts: true,
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Group created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Group" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/v1/groups/{group_id}/members": {
      post: {
        tags: ["Groups"],
        summary: "Add or reactivate a member",
        description:
          "Local bootstrap shortcut. The production version will use a single-use invitation and authenticated acceptance.",
        parameters: [{ $ref: "#/components/parameters/GroupId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AddMemberRequest" },
              example: {
                actor_member_id: "owner-member-id",
                user_id: "user-id-for-beena",
                role: "member",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Member added",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Member" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/v1/groups/{group_id}/expenses": {
      get: {
        tags: ["Expenses"],
        summary: "List active expenses",
        parameters: [
          { $ref: "#/components/parameters/GroupId" },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            example: 50,
          },
        ],
        responses: {
          "200": {
            description: "Expenses",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Expense" } },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      post: {
        tags: ["Expenses"],
        summary: "Create an equal or exact expense",
        description:
          "The service writes the header, payer, shares, and audit event in one transaction. Amounts are integer paise.",
        parameters: [{ $ref: "#/components/parameters/GroupId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateExpenseRequest" },
              examples: {
                equalSplit: {
                  summary: "Equal split",
                  value: {
                    actor_member_id: "owner-member-id",
                    description: "Dinner",
                    amount_paise: 120000,
                    expense_date: "2026-08-30",
                    split_method: "equal",
                    payer_member_id: "owner-member-id",
                    participant_member_ids: ["owner-member-id", "beena-member-id", "charan-member-id"],
                  },
                },
                exactSplit: {
                  summary: "Exact split",
                  value: {
                    actor_member_id: "owner-member-id",
                    description: "Hotel room",
                    amount_paise: 300000,
                    expense_date: "2026-08-30",
                    split_method: "exact",
                    payer_member_id: "owner-member-id",
                    exact_shares: [
                      { member_id: "owner-member-id", owed_paise: 100000 },
                      { member_id: "beena-member-id", owed_paise: 80000 },
                      { member_id: "charan-member-id", owed_paise: 120000 },
                    ],
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Expense created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Expense" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/v1/groups/{group_id}/balances": {
      get: {
        tags: ["Balances"],
        summary: "Calculate balances and suggested transfers",
        description:
          "Balances are derived from active expenses and settlements. They are not stored as mutable values.",
        parameters: [{ $ref: "#/components/parameters/GroupId" }],
        responses: {
          "200": {
            description: "Derived balances",
            content: { "application/json": { schema: { $ref: "#/components/schemas/BalanceResult" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/v1/groups/{group_id}/settlements": {
      post: {
        tags: ["Settlements"],
        summary: "Record an external settlement",
        description: "This records money paid outside the application, such as UPI or cash.",
        parameters: [{ $ref: "#/components/parameters/GroupId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateSettlementRequest" },
              example: {
                actor_member_id: "beena-member-id",
                paid_by_member_id: "beena-member-id",
                received_by_member_id: "owner-member-id",
                amount_paise: 40000,
                settlement_date: "2026-08-30",
                payment_method: "upi",
                notes: "Paid through UPI",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Settlement recorded",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Settlement" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
  },
  components: {
    parameters: {
      GroupId: {
        name: "group_id",
        in: "path",
        required: true,
        schema: { type: "string" },
        example: "group-id-from-create-group",
      },
    },
    responses: {
      BadRequest: {
        description: "Invalid request",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Forbidden: {
        description: "Actor is not authorized",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      NotFound: {
        description: "Resource was not found",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Conflict: {
        description: "Request conflicts with current state",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      ServiceUnavailable: {
        description: "Dependency is not ready",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
    schemas: {
      Health: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", example: "ok" } },
      },
      Error: {
        type: "object",
        required: ["error", "message"],
        properties: {
          error: { type: "string", example: "Bad Request" },
          message: { type: "string", example: "amount_paise must be a positive integer" },
        },
      },
      CreateUserRequest: {
        type: "object",
        required: ["email", "display_name"],
        properties: {
          email: { type: "string", format: "email" },
          display_name: { type: "string", example: "Anil" },
          timezone: { type: "string", default: "Asia/Kolkata" },
        },
      },
      User: {
        type: "object",
        required: ["id", "email", "display_name", "timezone"],
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          display_name: { type: "string" },
          timezone: { type: "string" },
        },
      },
      CreateGroupRequest: {
        type: "object",
        required: ["owner_user_id", "name"],
        properties: {
          owner_user_id: { type: "string" },
          name: { type: "string", example: "Weekend trip" },
          description: { type: "string" },
          simplify_debts: { type: "boolean", default: true },
        },
      },
      Group: {
        type: "object",
        required: ["id", "name", "owner_user_id", "owner_member_id", "simplify_debts"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string" },
          owner_user_id: { type: "string" },
          owner_member_id: { type: "string" },
          simplify_debts: { type: "boolean" },
        },
      },
      MembershipGroup: {
        type: "object",
        required: ["group_id", "name", "role", "member_id", "simplify_debts"],
        properties: {
          group_id: { type: "string" },
          name: { type: "string" },
          role: { type: "string", enum: ["owner", "admin", "member"] },
          member_id: { type: "string" },
          simplify_debts: { type: "boolean" },
        },
      },
      AddMemberRequest: {
        type: "object",
        required: ["actor_member_id", "user_id"],
        properties: {
          actor_member_id: { type: "string" },
          user_id: { type: "string" },
          role: { type: "string", enum: ["member", "admin"], default: "member" },
        },
      },
      Member: {
        type: "object",
        required: ["member_id", "group_id", "user_id", "role", "status"],
        properties: {
          member_id: { type: "string" },
          group_id: { type: "string" },
          user_id: { type: "string" },
          role: { type: "string", enum: ["owner", "admin", "member"] },
          status: { type: "string", enum: ["active", "left"] },
        },
      },
      ShareInput: {
        type: "object",
        required: ["member_id", "owed_paise"],
        properties: {
          member_id: { type: "string" },
          owed_paise: { type: "integer", format: "int64", minimum: 1, example: 40000 },
        },
      },
      CreateExpenseRequest: {
        type: "object",
        required: [
          "actor_member_id",
          "description",
          "amount_paise",
          "expense_date",
          "split_method",
          "payer_member_id",
        ],
        properties: {
          actor_member_id: { type: "string" },
          description: { type: "string", example: "Dinner" },
          amount_paise: { type: "integer", format: "int64", minimum: 1, example: 120000 },
          expense_date: { type: "string", format: "date", example: "2026-08-30" },
          category: { type: "string", example: "food" },
          notes: { type: "string" },
          split_method: { type: "string", enum: ["equal", "exact"] },
          payer_member_id: { type: "string" },
          participant_member_ids: {
            type: "array",
            items: { type: "string" },
            description: "Required for equal splits.",
          },
          exact_shares: {
            type: "array",
            items: { $ref: "#/components/schemas/ShareInput" },
            description: "Required for exact splits; shares must sum to amount_paise.",
          },
        },
      },
      Payer: {
        type: "object",
        required: ["member_id", "amount_paise"],
        properties: {
          member_id: { type: "string" },
          amount_paise: { type: "integer", format: "int64" },
        },
      },
      Share: {
        type: "object",
        required: ["member_id", "owed_paise"],
        properties: {
          member_id: { type: "string" },
          owed_paise: { type: "integer", format: "int64" },
        },
      },
      Expense: {
        type: "object",
        required: [
          "id",
          "group_id",
          "description",
          "amount_paise",
          "currency",
          "expense_date",
          "split_method",
          "payer",
          "shares",
          "version",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          group_id: { type: "string" },
          description: { type: "string" },
          amount_paise: { type: "integer", format: "int64" },
          currency: { type: "string", enum: ["INR"] },
          expense_date: { type: "string", format: "date" },
          category: { type: "string" },
          notes: { type: "string" },
          split_method: { type: "string", enum: ["equal", "exact"] },
          payer: { $ref: "#/components/schemas/Payer" },
          shares: { type: "array", items: { $ref: "#/components/schemas/Share" } },
          version: { type: "integer", minimum: 1 },
        },
      },
      Balance: {
        type: "object",
        required: ["member_id", "user_id", "display_name", "status", "balance_paise"],
        properties: {
          member_id: { type: "string" },
          user_id: { type: "string" },
          display_name: { type: "string" },
          status: { type: "string", enum: ["active", "left"] },
          balance_paise: { type: "integer", format: "int64", example: -40000 },
        },
      },
      SuggestedTransfer: {
        type: "object",
        required: ["from_member_id", "to_member_id", "amount_paise"],
        properties: {
          from_member_id: { type: "string" },
          to_member_id: { type: "string" },
          amount_paise: { type: "integer", format: "int64" },
        },
      },
      BalanceResult: {
        type: "object",
        required: ["group_id", "balances", "suggested_transfers", "total_paise"],
        properties: {
          group_id: { type: "string" },
          balances: { type: "array", items: { $ref: "#/components/schemas/Balance" } },
          suggested_transfers: {
            type: "array",
            items: { $ref: "#/components/schemas/SuggestedTransfer" },
          },
          total_paise: { type: "integer", format: "int64", example: 0 },
        },
      },
      CreateSettlementRequest: {
        type: "object",
        required: [
          "actor_member_id",
          "paid_by_member_id",
          "received_by_member_id",
          "amount_paise",
          "settlement_date",
          "payment_method",
        ],
        properties: {
          actor_member_id: { type: "string" },
          paid_by_member_id: { type: "string" },
          received_by_member_id: { type: "string" },
          amount_paise: { type: "integer", format: "int64", minimum: 1, example: 40000 },
          settlement_date: { type: "string", format: "date", example: "2026-08-30" },
          payment_method: {
            type: "string",
            enum: ["upi", "cash", "bank_transfer", "other"],
          },
          notes: { type: "string" },
        },
      },
      Settlement: {
        type: "object",
        required: [
          "id",
          "group_id",
          "paid_by_member_id",
          "received_by_member_id",
          "amount_paise",
          "currency",
          "settlement_date",
          "payment_method",
          "version",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          group_id: { type: "string" },
          paid_by_member_id: { type: "string" },
          received_by_member_id: { type: "string" },
          amount_paise: { type: "integer", format: "int64" },
          currency: { type: "string", enum: ["INR"] },
          settlement_date: { type: "string", format: "date" },
          payment_method: {
            type: "string",
            enum: ["upi", "cash", "bank_transfer", "other"],
          },
          notes: { type: "string" },
          version: { type: "integer", minimum: 1 },
        },
      },
    },
  },
} as const;
