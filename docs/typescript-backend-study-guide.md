# TypeScript backend study guide

The backend is a TypeScript modular monolith running on Node.js. It uses the
built-in `node:http` server and `node:test`, with `sql.js` as the only
runtime dependency. The raw SQL migration remains the source of truth.

## Why TypeScript for this project?

TypeScript is a good fit for this project because it keeps us close to the
browser and JSON API while adding compile-time checks over JavaScript:

| Decision | Benefit | Trade-off |
| --- | --- | --- |
| TypeScript | Catches many shape and naming mistakes before runtime | Types disappear at runtime; request data still needs validation |
| Node.js | Same language across a future web client and API; large ecosystem | JavaScript execution is single-threaded; CPU-heavy work blocks the event loop |
| Built-in `node:http` | Routing, request parsing, and server timeouts are visible | More manual code than Express or Fastify |
| `sql.js` | Pure WebAssembly SQLite avoids native build/toolchain problems in the preview | The database runs in memory and is saved back to a file; large workloads should move to a native driver or PostgreSQL |
| Modular monolith | Keeps expense rows and audit events in one local transaction | Modules deploy and scale together |

The interview answer should not be “TypeScript is faster” or “Node.js scales
forever.” A better answer is:

> I chose TypeScript because the product will eventually have a browser client,
> the team can share types and tooling, and compile-time checks improve the
> safety of the domain code. I kept the backend framework-light so the
> transaction and authorization boundaries are easy to explain. I would choose
> Fastify, NestJS, Go, or Java if team expertise and operational requirements
> made one of them a better fit.

## What was implemented

```text
src/index.ts
  -> src/http/server.ts       HTTP routes, JSON parsing, request IDs
  -> src/services/accounts.ts temporary user bootstrap operation
  -> src/services/groups.ts   group + owner + member transactions
  -> src/services/expenses.ts equal/exact allocation transaction
  -> src/services/settlements.ts settlement transaction and authorization
  -> src/services/balance.ts  balance view and transfer algorithm
  -> src/db/database.ts       SQLite pragmas and checksummed migrations
```

One process and one database make this a modular monolith, not a collection of
microservices. That is important because an expense and its audit event should
commit together.

## Run it

```bash
npm install
npm test
npm run build
npm start
```

The server binds to `0.0.0.0:8080` by default. Configuration is through:

```bash
PORT=8080 DATABASE_FILE=data/share.db npm start
```

Migrations can also be run explicitly:

```bash
npm run db:migrate
```

Interactive API documentation is served at `http://localhost:8080/docs`. It is
backed by `src/http/openapi.ts`, so the examples show the same snake_case JSON
contract used by the HTTP adapter. The machine-readable document is at
`/openapi.json`.

## API walkthrough

Create a temporary user:

```bash
curl -s localhost:8080/v1/users \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"anil@example.com","display_name":"Anil"}'
```

Create a group using the returned user ID:

```bash
curl -s localhost:8080/v1/groups \\
  -H 'Content-Type: application/json' \\
  -d '{"owner_user_id":"USER_ID","name":"Weekend trip"}'
```

Create another user, then add that user to the group. This direct member
operation is a local bootstrap shortcut; production will use a single-use
invitation and authenticated acceptance.

```bash
curl -s localhost:8080/v1/groups/GROUP_ID/members \\
  -H 'Content-Type: application/json' \\
  -d '{"actor_member_id":"OWNER_MEMBER_ID","user_id":"OTHER_USER_ID"}'
```

Create an equal-split expense:

```bash
curl -s localhost:8080/v1/groups/GROUP_ID/expenses \\
  -H 'Content-Type: application/json' \\
  -d '{
    "actor_member_id":"OWNER_MEMBER_ID",
    "description":"Dinner",
    "amount_paise":120000,
    "expense_date":"2026-08-29",
    "split_method":"equal",
    "payer_member_id":"OWNER_MEMBER_ID",
    "participant_member_ids":["OWNER_MEMBER_ID","OTHER_MEMBER_ID"]
  }'
```

Read balances and suggested transfers:

```bash
curl -s localhost:8080/v1/groups/GROUP_ID/balances
```

Authentication is deliberately the next milestone. The current API accepts
`actor_member_id` so the domain can be exercised locally; production must
obtain the actor from a server-managed session.

## TypeScript concepts to learn from this code

### Compile-time types are not runtime validation

This type is useful inside the application:

```ts
interface CreateExpenseInput {
  amountPaise: number;
  splitMethod: "equal" | "exact";
}
```

But a JSON request can contain anything. `src/http/server.ts` validates the
incoming object before passing it to the service. TypeScript prevents mistakes
between our own functions; it does not protect the API boundary by itself.

### `unknown` is safer than `any`

Parsed JSON starts as `unknown`. The HTTP layer checks whether it is an object,
string, array, boolean, or safe integer before using it. `any` would silence
those checks and move bugs to runtime.

### Errors and business boundaries

Services throw `DomainError` for expected outcomes such as validation,
not-found, conflict, and forbidden. The HTTP adapter maps those to 400, 404,
409, and 403 without exposing SQL details. Unexpected errors become 500.

Interview prompt: **why not return raw database errors?** They can leak schema
information and do not give clients a stable contract.

### Transactions

The expense service executes this sequence inside one `sql.js`
transaction:

1. validate active actor, payer, and participants;
2. calculate integer shares;
3. insert the expense header;
4. insert payer and share rows;
5. verify payer total equals expense total equals share total;
6. insert the audit event; and
7. commit.

If one operation throws, `sql.js` rolls back the transaction callback.
There cannot be a committed expense without its audit record.

### Why synchronous sql.js SQLite is acceptable here

`sql.js` runs SQLite compiled to WebAssembly. It gives a straightforward
transaction API without requiring native Node headers or a C compiler in this
preview environment. Its cost is that every query is synchronous and the
whole database is loaded into memory; writes export the database back to the
SQLite file. That is acceptable while the database and queries are small. For
production scale, move to a native/async driver or PostgreSQL, and move
CPU-heavy tasks to workers.

### Node.js concurrency

Node.js can serve many I/O-oriented requests because the event loop does not
wait on ordinary network operations. A synchronous SQLite query does block it.
The single-threaded event loop also does not make a multi-step write atomic;
the database transaction provides atomicity.

### Interfaces are optional in TypeScript

The code uses concrete service classes because there is no need to abstract
every class. If a handler needs a fake service in tests, define a small
interface at the consumer boundary. Avoid interfaces that only mirror one
implementation and add no substitution or design value.

## Interview questions and answer points

### Why TypeScript instead of Go, Java, or Python?

TypeScript shares language and types with a future frontend and has a large web
ecosystem. Go gives a simpler compiled binary and explicit concurrency. Java
gives a mature enterprise ecosystem and strong tooling. Python can maximize
iteration speed but requires more care around runtime typing and performance.
The choice depends on team skills, product boundaries, deployment, and scale.

### Why not Express or NestJS?

The built-in server keeps the learning surface small and makes HTTP behavior
visible. Express or Fastify would be reasonable as routes, validation, and
middleware grow. NestJS can give structure to a large team but also adds
framework conventions that are not needed for this first vertical slice.

### Why not an ORM?

The SQL schema and financial invariants are part of the interview exercise.
Raw SQL makes indexes, joins, transactions, and aggregate checks visible. An
ORM can be introduced later for mapping convenience, but it should not hide
same-group constraints or sum validation.

### Why use integer paise?

Floating-point rupees can represent decimal amounts imprecisely. Integer paise
makes equality and sum checks exact. The TypeScript boundary additionally
requires safe integers because JavaScript numbers are exact only up to
`Number.MAX_SAFE_INTEGER`. If amounts could exceed that range, use `bigint` or
string-based decimal handling consistently at the API and database boundary.

### Why derive balances?

Expenses and settlements are source facts. A mutable balance row can drift
when a write partially fails, an expense is edited, or a retry is duplicated.
The current balance view is easy to rebuild and reconcile. A materialized
projection can be introduced later without replacing the source facts.

### What does optimistic concurrency solve?

An expense version lets an update say “apply only if the current version is 3.”
A competing update changes the version first, so the second update affects zero
rows and returns a conflict rather than silently losing data. It is still
necessary to validate authorization and use a transaction.

### How do you make writes retry-safe?

Accept an idempotency key scoped to the authenticated actor and group. Store it
with the resulting entity under a unique constraint and return the existing
result for a retry. A client-generated ID is only useful if the server persists
and enforces it.

### What if notifications fail after an expense commits?

Do not roll back the expense because email failed. Write a transactional outbox
row with the expense, commit both, and let a worker retry delivery. Consumers
must tolerate at-least-once delivery.

### What is the authentication gap in this implementation?

The current API accepts an actor ID for local learning. That is not a security
boundary. Authentication identifies the account; authorization checks whether
that account has the required group membership and role. The next milestone
should derive the actor from a secure session on every request.

### When would you leave SQLite?

Signals include sustained write lock contention, a need for multiple API
instances, point-in-time recovery or replicas, or data size beyond the desired
single-node envelope. PostgreSQL would preserve the relational model and
transaction boundaries while improving operational and concurrent-write
capacity.

### How would you test it?

Use table-driven tests for rounding and transfer matching. Use database
integration tests for foreign keys, transaction rollback, allocation totals,
soft deletion, and audit rows. Use HTTP tests for JSON contracts and status
codes. Add concurrency tests for invitation acceptance and same-version edits.

### What should be monitored?

Track request latency and errors by route, SQLite busy/lock failures,
transaction rollback counts, migration failures, authorization failures,
unbalanced allocation diagnostics, non-zero balance sums, and backup/restore
success. Include request IDs in logs, but never log invitation tokens or payment
credentials.

## Interview closing statement

> I started with a TypeScript modular monolith because correctness and learning
> are more important than distribution for this domain. The relational schema
> stores financial facts in paise, the service validates aggregate invariants in
> a transaction, and balances are derived. I would measure contention and query
> latency before introducing PostgreSQL, projections, queues, or microservices.
