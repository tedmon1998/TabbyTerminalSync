-- Tabby PostgreSQL Sync migration
-- The app applies this idempotent migration on its first successful sync.

CREATE SCHEMA IF NOT EXISTS tabby_sync;

CREATE TABLE IF NOT EXISTS tabby_sync.objects (
    scope text NOT NULL DEFAULT 'default',
    object_type text NOT NULL CHECK (object_type IN ('settings', 'profile', 'profile-group', 'command-topic', 'command')),
    object_id text NOT NULL,
    payload jsonb,
    revision bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text NOT NULL,
    deleted_at timestamptz,
    PRIMARY KEY (scope, object_type, object_id)
);

CREATE TABLE IF NOT EXISTS tabby_sync.conflicts (
    id bigserial PRIMARY KEY,
    scope text NOT NULL DEFAULT 'default',
    object_type text NOT NULL,
    object_id text NOT NULL,
    local_payload jsonb,
    remote_payload jsonb,
    local_updated_at timestamptz NOT NULL,
    remote_updated_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS objects_updated_at_idx ON tabby_sync.objects (scope, updated_at);
CREATE INDEX IF NOT EXISTS conflicts_open_idx ON tabby_sync.conflicts (scope, resolved_at) WHERE resolved_at IS NULL;

-- Upgrade databases initialized by the earlier profiles-and-commands build.
ALTER TABLE tabby_sync.objects DROP CONSTRAINT IF EXISTS objects_type_check;
ALTER TABLE tabby_sync.objects DROP CONSTRAINT IF EXISTS objects_object_type_check;
ALTER TABLE tabby_sync.objects ADD CONSTRAINT objects_type_check
    CHECK (object_type IN ('settings', 'profile', 'profile-group', 'command-topic', 'command'));

-- After applying the migration, a dedicated runtime account needs only:
-- GRANT USAGE ON SCHEMA tabby_sync TO tabby_runtime;
-- GRANT SELECT, INSERT, UPDATE ON tabby_sync.objects, tabby_sync.conflicts TO tabby_runtime;
-- GRANT USAGE, SELECT ON SEQUENCE tabby_sync.conflicts_id_seq TO tabby_runtime;
