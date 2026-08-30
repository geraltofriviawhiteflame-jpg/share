# System Design Interview Study Guide

## Purpose

This project is both a working shared-expense tracker and a system-design learning exercise. The goal is not to add distributed-system components merely to make the diagram look advanced. The goal is to understand the simple design, identify its limits, and explain evidence-based evolution.

The implemented MVP starts as a modular monolith with SQLite. During interview practice, the same domain can be discussed at successively larger scales, including PostgreSQL, caching, asynchronous work, replicas, and service decomposition.

## How to use the project

For each milestone:

1. state the functional and non-functional requirements;
2. draw the relevant request and data flow;
3. identify invariants and failure modes;
4. implement the smallest design that meets the current requirements;
5. test both success and failure paths;
6. inspect behavior using logs, SQL, and query plans;
7. record the trade-off and the signal that would require a redesign; and
8. practice explaining the decision without referring to framework magic.

## Interview narrative

A strong interview explanation can follow this order:

1. **Clarify scope:** shared expense tracking, not payment processing; accounts are required; INR only initially.
2. **Identify core operations:** groups, membership, invitations, expenses, balances, and settlements.
3. **State correctness requirements:** no floating-point money, balanced allocations, same-group participants, authorized edits, idempotent writes, and auditable changes.
4. **Estimate scale:** choose explicit read/write and retention assumptions before discussing infrastructure.
5. **Present the high-level design:** clients, stateless application API, relational source of truth, and optional asynchronous workers.
6. **Deep-dive into the ledger:** explain expense payer/share facts, settlement effects, and derived balances.
7. **Discuss consistency and concurrency:** transaction boundaries, optimistic versions, retries, and duplicate prevention.
8. **Discuss read scaling:** indexes, aggregate queries, cached/materialized balances, invalidation, and reconciliation.
9. **Discuss reliability and security:** backups, restore tests, authorization, invitation-token handling, audit events, and observability.
10. **Evolve the design only when justified:** SQLite to PostgreSQL, one instance to multiple instances, synchronous notifications to a queue, and modular monolith to selected services.

## Milestone 1: Relational model in raw SQL

Current focus:

- normalized source-of-truth tables;
- primary, foreign, composite, and unique keys;
- row-level `CHECK` constraints;
- integer paise representation;
- indexes based on expected access patterns;
- soft deletion and audit history;
- derived balance views; and
- versioned, checksummed migrations.

Questions to be able to answer:

- Why is `group_members` separate from `users`?
- Why do expenses have payer and share child tables?
- Why not store a member's current balance directly?
- Why is settlement sender balance impact positive and receiver impact negative?
- Which rules can the database enforce on one row?
- Why must allocation sums be checked in an application transaction?
- Why are cross-group references protected with composite foreign keys?
- What access pattern does each index support?
- Why do we soft-delete financial records?
- What happens if an already-applied migration file changes?

Exit criteria:

- The schema applies to an empty database.
- Re-running the migration command is safe.
- Foreign-key and integrity checks pass.
- Executable tests demonstrate constraints and balance arithmetic.
- An intentionally inconsistent allocation is detectable.

## Milestone 2: Transactional domain services

The first TypeScript implementation now provides a runnable starting point for
the core create/read flows. Authentication, invitations, edits, and optimistic
concurrency remain intentionally next. Implement the remaining use cases
without a web interface first:

- create a group and its owner atomically;
- accept an invitation without duplicate membership;
- create equal and exact expenses;
- edit an expense using an expected version;
- soft-delete and restore an expense;
- record and correct a settlement; and
- calculate suggested transfers.

The most important expense transaction contains:

```text
validate actor and group membership
validate input and calculate integer allocations
insert/update expense header
replace payer and share rows
verify payer total = expense total = share total
write activity event
commit
```

Questions to be able to answer:

- What can fail halfway through this operation?
- Why is one transaction necessary?
- What isolation behavior does SQLite provide for concurrent writers?
- How does an optimistic `version` prevent a lost update?
- How does a retry avoid creating the same expense twice?
- Would an outbox be needed if a notification must be reliably sent after commit?

## Milestone 3: API design

Define the API contract before connecting the UI. Likely resource boundaries include:

```text
/groups
/groups/{groupId}/members
/groups/{groupId}/invitations
/groups/{groupId}/expenses
/groups/{groupId}/balances
/groups/{groupId}/settlements
/groups/{groupId}/activity
```

Study topics:

- resource-oriented endpoints versus action endpoints;
- authentication versus group authorization;
- request validation and stable error contracts;
- cursor pagination for expense and activity feeds;
- idempotency keys for write retries;
- optimistic concurrency with a version or `If-Match` header;
- avoiding identifiers that bypass group-boundary checks; and
- API evolution and backward compatibility.

## Milestone 4: Application and authentication

Connect a responsive web client to server-side use cases. Keep domain calculations outside React components and route handlers.

Study topics:

- session management and cookie security;
- OAuth or email verification boundaries;
- server-side authorization on every group resource;
- CSRF, XSS, injection, and rate limiting;
- invitation-token entropy, hashing, expiry, and one-time use;
- preventing account enumeration; and
- keeping SQLite and secrets outside the public web directory.

## Milestone 5: Correctness under concurrency

Add tests that deliberately race:

- two edits using the same expense version;
- two acceptances of one invitation;
- two attempts to create or transfer group ownership;
- duplicate client retries; and
- an expense read while another request is editing it.

Be able to distinguish:

- atomicity from isolation;
- optimistic from pessimistic concurrency control;
- database uniqueness from application pre-checks;
- retryable lock contention from permanent validation failure; and
- at-least-once delivery from exactly-once business effects.

## Milestone 6: Observability and reliability

Add:

- structured request logs with correlation IDs;
- latency and error metrics by use case;
- counters for constraint failures and retryable lock errors;
- diagnostics for unbalanced expenses and non-zero group balance sums;
- backup automation;
- a tested restoration procedure; and
- health checks that distinguish process health from database readiness.

Interview questions:

- How would an operator detect balance corruption?
- Which alerts are actionable?
- How are logs correlated across a retried request?
- What are the recovery point and recovery time objectives?
- How do you restore without accepting conflicting writes?

## Milestone 7: Capacity and scale evolution

Before changing architecture, choose and state a hypothetical interview workload:

```text
registered users
monthly and daily active users
groups per active user
expenses per active group per month
peak-to-average request ratio
expense retention period
read-to-write ratio
receipt size and retention, if receipts are later introduced
```

Use those assumptions to estimate:

- peak request rate;
- database rows added per day and per year;
- primary data size;
- index size;
- network and receipt-storage requirements; and
- acceptable latency for balance and activity reads.

Then evolve in steps:

### SQLite to PostgreSQL

Trigger signals include sustained write lock contention, a need for multiple application instances, stronger operational tooling, point-in-time recovery, replicas, or data volume beyond the desired single-node envelope.

### Computed to materialized balances

Keep expenses and settlements as the source of truth. Introduce transactional aggregate tables or asynchronously refreshed projections only when measured balance-query cost requires it. Add reconciliation that can rebuild aggregates from source transactions.

### Synchronous to asynchronous side effects

Notifications, email, receipt processing, and analytics can move behind a durable queue. Use a transactional outbox when database commit and event publication must not diverge.

### Single database to partitioning

A natural partition key is `group_id` because most financial operations are group-scoped. Discuss cross-group user dashboards, hot groups, resharding, and global identity before proposing sharding.

### Modular monolith to services

Possible future boundaries include identity, group/expense ledger, notifications, and attachments. Split only for independent scaling, ownership, reliability, or deployment needs; avoid distributed transactions around the core ledger without a clear benefit.

## Trade-off log

The current important decisions are:

| Decision | Benefit | Cost or limit | Revisit signal |
| --- | --- | --- | --- |
| SQLite | Simple operation and excellent learning surface | Single-writer and single-node constraints | Sustained contention or multiple app instances |
| Modular monolith | Simple transactions and deployment | Modules scale together | Independent ownership or scaling requirement |
| Integer paise | Exact arithmetic | Explicit formatting and conversion | Multi-currency still uses minor units, not floats |
| Derived balances | Cannot drift from source transactions | Aggregate reads grow with history | Measured query cost exceeds latency target |
| Account-only members | Simple identity and authorization | More invitation friction | Strong need for guest participation |
| Soft deletion | Explainable history and recovery | Retention/privacy complexity | Formal erasure and retention requirements |
| Raw SQL first | Makes constraints and queries visible | More manual mapping work | Add ORM after the schema is understood |

New architecture decisions should be added with the rejected alternatives and the evidence behind the choice.

## Topics intentionally deferred

These are valid system-design topics but should not be implemented before the core design needs them:

- microservices;
- distributed caches;
- Kafka or another event-streaming platform;
- database sharding;
- multi-region active-active writes;
- CQRS as separate infrastructure;
- payment processing and financial compliance; and
- receipt object storage and malware scanning.

They should still be discussable as possible evolutions, including the new failure modes each introduces.
