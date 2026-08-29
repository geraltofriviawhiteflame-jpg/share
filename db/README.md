# Database learning track

The database is implemented with raw, versioned SQLite migrations before an ORM is introduced. This is intentional: the schema is part of the system design, not an implementation detail to delegate without understanding.

## What to learn from this layer

- Why facts such as expenses and settlements are stored while balances are derived
- How primary keys, foreign keys, unique indexes, partial indexes, and `CHECK` constraints protect data
- Which invariants SQLite can enforce and which require an application transaction
- How composite foreign keys prevent cross-group financial references
- Why money is represented as integer paise
- How soft deletion changes balance queries
- How indexes follow access patterns rather than being added indiscriminately
- Why a migration is immutable after it has been applied
- Where SQLite's single-writer architecture becomes a scaling constraint

## Files

```text
db/migrations/0001_initial.sql  Initial tables, indexes, and views
scripts/migrate.py               Dependency-free migration runner
tests/test_database_schema.py    Executable constraint and balance examples
```

## Create a local database

Python 3 includes the SQLite driver, so the external `sqlite3` command is not required:

```bash
python3 scripts/migrate.py up
```

The default database is `data/share.db`. To choose a different file:

```bash
python3 scripts/migrate.py up --database /tmp/share.db
```

Inspect migration status:

```bash
python3 scripts/migrate.py status
```

Run the executable schema tests:

```bash
python3 -m unittest discover -s tests -v
```

## Migration rules

1. A migration filename has the form `NNNN_lowercase_name.sql`.
2. Applied migrations are tracked in `schema_migrations` with a SHA-256 checksum.
3. Never edit an applied migration in a shared environment; add the next migration instead.
4. Migration files do not contain `BEGIN` or `COMMIT`; the runner wraps each migration and its metadata record in one transaction.
5. Foreign-key enforcement is enabled on every connection, not only during migration.
6. Application startup will eventually run migration status checks, while production migration execution remains an explicit deployment step.

## Important design boundary

The database enforces row-level and relationship invariants, including positive amounts, valid enum values, one membership per user and group, at most one active owner, and same-group references.

A normal SQLite `CHECK` constraint cannot compare an expense with the sum of rows in `expense_payers` and `expense_shares`. The future expense service must therefore write the expense header, payer rows, share rows, and activity event in one transaction and verify:

```text
sum(payer amounts) = expense amount = sum(share amounts)
```

The `expense_allocation_totals` view makes violations observable and is useful for tests and operational diagnostics. It does not replace validation in the write path.

## Useful study queries

After loading data, inspect a member's derived balance:

```sql
SELECT member_id, balance_paise
FROM group_member_balances
WHERE group_id = :group_id
ORDER BY member_id;
```

Check allocation integrity:

```sql
SELECT expense_id, amount_paise, paid_paise, owed_paise
FROM expense_allocation_totals
WHERE is_balanced = 0;
```

Inspect the components behind a balance:

```sql
SELECT member_id, source_type, source_id, delta_paise
FROM balance_components
WHERE group_id = :group_id
ORDER BY member_id, source_type, source_id;
```

When realistic data exists, run `EXPLAIN QUERY PLAN` for these access patterns and compare the plan before and after relevant indexes.

## SQLite-to-PostgreSQL discussion

SQLite is appropriate for this personal learning project because it provides transactions, foreign keys, views, indexes, and enough concurrency for a small deployment with one application instance.

For an interview, be ready to explain the migration trigger rather than claiming SQLite scales indefinitely. Signals include sustained write contention, multiple application instances, operational requirements for replicas or point-in-time recovery, and a workload that no longer fits the single-writer model. The domain model can then move to PostgreSQL while preserving integer money values, relational keys, and transaction boundaries.
