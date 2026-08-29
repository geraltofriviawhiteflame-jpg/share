-- Initial relational schema for the shared expense tracker.
--
-- This file intentionally contains raw SQL so the database design, constraints,
-- indexes, and derived views can be studied without an ORM abstraction. The
-- migration runner supplies the surrounding transaction and records the
-- migration checksum. Do not add BEGIN or COMMIT statements to this file.

CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE
        CHECK (trim(email) <> ''),
    display_name TEXT NOT NULL
        CHECK (trim(display_name) <> ''),
    avatar_url TEXT,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'
        CHECK (trim(timezone) <> ''),
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at TEXT
) STRICT;

CREATE TABLE groups (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL
        CHECK (trim(name) <> ''),
    description TEXT,
    default_currency TEXT NOT NULL DEFAULT 'INR'
        CHECK (default_currency = 'INR'),
    created_by_user_id TEXT NOT NULL,
    simplify_debts INTEGER NOT NULL DEFAULT 1
        CHECK (simplify_debts IN (0, 1)),
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    archived_at TEXT,
    FOREIGN KEY (created_by_user_id)
        REFERENCES users (id)
        ON DELETE RESTRICT
) STRICT;

CREATE TABLE group_members (
    id TEXT PRIMARY KEY NOT NULL,
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'admin', 'member')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'left')),
    joined_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    left_at TEXT,
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (group_id)
        REFERENCES groups (id)
        ON DELETE CASCADE,
    FOREIGN KEY (user_id)
        REFERENCES users (id)
        ON DELETE RESTRICT,
    UNIQUE (group_id, user_id),
    UNIQUE (group_id, id),
    CHECK (
        (status = 'active' AND left_at IS NULL)
        OR (status = 'left' AND left_at IS NOT NULL)
    )
) STRICT;

-- This enforces "at most one" active owner. The group service must also ensure
-- that every non-archived group has an owner and that ownership transfers are
-- completed atomically.
CREATE UNIQUE INDEX group_members_one_active_owner_per_group
    ON group_members (group_id)
    WHERE role = 'owner' AND status = 'active';

CREATE TABLE group_invitations (
    id TEXT PRIMARY KEY NOT NULL,
    group_id TEXT NOT NULL,
    invited_by_member_id TEXT NOT NULL,
    invited_email TEXT COLLATE NOCASE,
    role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('admin', 'member')),
    token_hash TEXT NOT NULL UNIQUE
        CHECK (trim(token_hash) <> ''),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    expires_at TEXT NOT NULL,
    accepted_by_user_id TEXT,
    accepted_at TEXT,
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (group_id)
        REFERENCES groups (id)
        ON DELETE CASCADE,
    FOREIGN KEY (group_id, invited_by_member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (accepted_by_user_id)
        REFERENCES users (id)
        ON DELETE RESTRICT,
    CHECK (invited_email IS NULL OR trim(invited_email) <> ''),
    CHECK (
        (
            status = 'accepted'
            AND accepted_by_user_id IS NOT NULL
            AND accepted_at IS NOT NULL
        )
        OR (
            status <> 'accepted'
            AND accepted_by_user_id IS NULL
            AND accepted_at IS NULL
        )
    )
) STRICT;

CREATE TABLE expenses (
    id TEXT PRIMARY KEY NOT NULL,
    group_id TEXT NOT NULL,
    description TEXT NOT NULL
        CHECK (trim(description) <> ''),
    amount_paise INTEGER NOT NULL
        CHECK (amount_paise > 0),
    currency TEXT NOT NULL DEFAULT 'INR'
        CHECK (currency = 'INR'),
    expense_date TEXT NOT NULL
        CHECK (
            expense_date GLOB
            '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        ),
    category TEXT
        CHECK (category IS NULL OR trim(category) <> ''),
    notes TEXT,
    split_method TEXT NOT NULL
        CHECK (split_method IN ('equal', 'exact')),
    created_by_member_id TEXT NOT NULL,
    updated_by_member_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
        CHECK (version > 0),
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at TEXT,
    deleted_by_member_id TEXT,
    FOREIGN KEY (group_id)
        REFERENCES groups (id)
        ON DELETE CASCADE,
    FOREIGN KEY (group_id, created_by_member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (group_id, updated_by_member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (group_id, deleted_by_member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT,
    UNIQUE (group_id, id),
    CHECK (
        (deleted_at IS NULL AND deleted_by_member_id IS NULL)
        OR (deleted_at IS NOT NULL AND deleted_by_member_id IS NOT NULL)
    )
) STRICT;

CREATE TABLE expense_payers (
    group_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    amount_paise INTEGER NOT NULL
        CHECK (amount_paise > 0),
    PRIMARY KEY (expense_id, member_id),
    FOREIGN KEY (group_id, expense_id)
        REFERENCES expenses (group_id, id)
        ON DELETE CASCADE,
    FOREIGN KEY (group_id, member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT
) STRICT;

CREATE TABLE expense_shares (
    group_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    owed_paise INTEGER NOT NULL
        CHECK (owed_paise > 0),
    PRIMARY KEY (expense_id, member_id),
    FOREIGN KEY (group_id, expense_id)
        REFERENCES expenses (group_id, id)
        ON DELETE CASCADE,
    FOREIGN KEY (group_id, member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT
) STRICT;

CREATE TABLE settlements (
    id TEXT PRIMARY KEY NOT NULL,
    group_id TEXT NOT NULL,
    paid_by_member_id TEXT NOT NULL,
    received_by_member_id TEXT NOT NULL,
    amount_paise INTEGER NOT NULL
        CHECK (amount_paise > 0),
    currency TEXT NOT NULL DEFAULT 'INR'
        CHECK (currency = 'INR'),
    settlement_date TEXT NOT NULL
        CHECK (
            settlement_date GLOB
            '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        ),
    payment_method TEXT NOT NULL
        CHECK (payment_method IN ('upi', 'cash', 'bank_transfer', 'other')),
    notes TEXT,
    created_by_member_id TEXT NOT NULL,
    updated_by_member_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
        CHECK (version > 0),
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at TEXT,
    deleted_by_member_id TEXT,
    FOREIGN KEY (group_id)
        REFERENCES groups (id)
        ON DELETE CASCADE,
    FOREIGN KEY (group_id, paid_by_member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (group_id, received_by_member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (group_id, created_by_member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (group_id, updated_by_member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (group_id, deleted_by_member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT,
    CHECK (paid_by_member_id <> received_by_member_id),
    CHECK (
        (deleted_at IS NULL AND deleted_by_member_id IS NULL)
        OR (deleted_at IS NOT NULL AND deleted_by_member_id IS NOT NULL)
    )
) STRICT;

CREATE TABLE activity_events (
    id TEXT PRIMARY KEY NOT NULL,
    group_id TEXT NOT NULL,
    actor_member_id TEXT,
    entity_type TEXT NOT NULL
        CHECK (
            entity_type IN (
                'expense',
                'settlement',
                'group',
                'member',
                'invitation'
            )
        ),
    entity_id TEXT NOT NULL
        CHECK (trim(entity_id) <> ''),
    action TEXT NOT NULL
        CHECK (
            action IN (
                'created',
                'updated',
                'deleted',
                'restored',
                'joined',
                'left',
                'invited',
                'accepted',
                'archived'
            )
        ),
    before_json TEXT
        CHECK (before_json IS NULL OR json_valid(before_json)),
    after_json TEXT
        CHECK (after_json IS NULL OR json_valid(after_json)),
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (group_id)
        REFERENCES groups (id)
        ON DELETE CASCADE,
    FOREIGN KEY (group_id, actor_member_id)
        REFERENCES group_members (group_id, id)
        ON DELETE RESTRICT
) STRICT;

CREATE INDEX group_members_by_user_and_status
    ON group_members (user_id, status);

CREATE INDEX group_members_by_group_and_status
    ON group_members (group_id, status);

CREATE INDEX group_invitations_by_group_status_and_expiry
    ON group_invitations (group_id, status, expires_at);

CREATE INDEX expenses_by_group_and_date
    ON expenses (group_id, expense_date DESC, created_at DESC);

CREATE INDEX expense_payers_by_group_and_member
    ON expense_payers (group_id, member_id);

CREATE INDEX expense_shares_by_group_and_member
    ON expense_shares (group_id, member_id);

CREATE INDEX settlements_by_group_and_date
    ON settlements (group_id, settlement_date DESC, created_at DESC);

CREATE INDEX settlements_by_group_and_payer
    ON settlements (group_id, paid_by_member_id);

CREATE INDEX settlements_by_group_and_receiver
    ON settlements (group_id, received_by_member_id);

CREATE INDEX activity_events_by_group_and_time
    ON activity_events (group_id, created_at DESC);

-- This diagnostic view makes the aggregate invariant visible. SQLite row-level
-- CHECK constraints cannot assert that the payer and share rows sum to the
-- expense amount; the expense application service must validate that invariant
-- in the same transaction used to write the expense.
CREATE VIEW expense_allocation_totals AS
SELECT
    e.group_id,
    e.id AS expense_id,
    e.amount_paise,
    COALESCE(
        (
            SELECT SUM(ep.amount_paise)
            FROM expense_payers AS ep
            WHERE ep.group_id = e.group_id
              AND ep.expense_id = e.id
        ),
        0
    ) AS paid_paise,
    COALESCE(
        (
            SELECT SUM(es.owed_paise)
            FROM expense_shares AS es
            WHERE es.group_id = e.group_id
              AND es.expense_id = e.id
        ),
        0
    ) AS owed_paise,
    CASE
        WHEN e.amount_paise = COALESCE(
            (
                SELECT SUM(ep.amount_paise)
                FROM expense_payers AS ep
                WHERE ep.group_id = e.group_id
                  AND ep.expense_id = e.id
            ),
            0
        )
        AND e.amount_paise = COALESCE(
            (
                SELECT SUM(es.owed_paise)
                FROM expense_shares AS es
                WHERE es.group_id = e.group_id
                  AND es.expense_id = e.id
            ),
            0
        )
        THEN 1
        ELSE 0
    END AS is_balanced
FROM expenses AS e;

-- Each row below is one signed contribution to a group member's balance.
-- Positive values mean the member should receive money; negative values mean
-- the member owes money.
CREATE VIEW balance_components AS
SELECT
    ep.group_id,
    ep.member_id,
    ep.amount_paise AS delta_paise,
    'expense_paid' AS source_type,
    ep.expense_id AS source_id
FROM expense_payers AS ep
JOIN expenses AS e
  ON e.group_id = ep.group_id
 AND e.id = ep.expense_id
WHERE e.deleted_at IS NULL

UNION ALL

SELECT
    es.group_id,
    es.member_id,
    -es.owed_paise AS delta_paise,
    'expense_share' AS source_type,
    es.expense_id AS source_id
FROM expense_shares AS es
JOIN expenses AS e
  ON e.group_id = es.group_id
 AND e.id = es.expense_id
WHERE e.deleted_at IS NULL

UNION ALL

SELECT
    s.group_id,
    s.paid_by_member_id AS member_id,
    s.amount_paise AS delta_paise,
    'settlement_sent' AS source_type,
    s.id AS source_id
FROM settlements AS s
WHERE s.deleted_at IS NULL

UNION ALL

SELECT
    s.group_id,
    s.received_by_member_id AS member_id,
    -s.amount_paise AS delta_paise,
    'settlement_received' AS source_type,
    s.id AS source_id
FROM settlements AS s
WHERE s.deleted_at IS NULL;

CREATE VIEW group_member_balances AS
SELECT
    gm.group_id,
    gm.id AS member_id,
    gm.user_id,
    COALESCE(SUM(bc.delta_paise), 0) AS balance_paise
FROM group_members AS gm
LEFT JOIN balance_components AS bc
  ON bc.group_id = gm.group_id
 AND bc.member_id = gm.id
GROUP BY gm.group_id, gm.id, gm.user_id;
