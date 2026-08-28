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
    resolved_at timestamptz,
    fingerprint text
);

CREATE INDEX IF NOT EXISTS objects_updated_at_idx ON tabby_sync.objects (scope, updated_at);
CREATE INDEX IF NOT EXISTS conflicts_open_idx ON tabby_sync.conflicts (scope, resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS conflicts_retention_idx ON tabby_sync.conflicts (scope, created_at);

-- Upgrade databases initialized by the earlier profiles-and-commands build.
ALTER TABLE tabby_sync.objects DROP CONSTRAINT IF EXISTS objects_type_check;
ALTER TABLE tabby_sync.objects DROP CONSTRAINT IF EXISTS objects_object_type_check;
ALTER TABLE tabby_sync.objects ADD CONSTRAINT objects_type_check
    CHECK (object_type IN ('settings', 'profile', 'profile-group', 'command-topic', 'command'));

-- Compact conflict storage. The generated fingerprint represents a distinct
-- local/remote payload pair for an object; reconnects cannot insert it twice.
ALTER TABLE tabby_sync.conflicts ADD COLUMN IF NOT EXISTS fingerprint text;

CREATE OR REPLACE FUNCTION tabby_sync.set_conflict_fingerprint()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
    NEW.fingerprint := md5(concat_ws(E'\\x1f', NEW.scope, NEW.object_type, NEW.object_id,
        coalesce(NEW.local_payload::text, '<null>'),
        coalesce(NEW.remote_payload::text, '<null>')));
    IF TG_OP = 'INSERT' THEN
        PERFORM pg_advisory_xact_lock(hashtext(NEW.fingerprint));
        IF EXISTS (
            SELECT 1 FROM tabby_sync.conflicts
            WHERE scope = NEW.scope AND object_type = NEW.object_type
              AND object_id = NEW.object_id AND fingerprint = NEW.fingerprint
        ) THEN
            RETURN NULL;
        END IF;
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS conflicts_set_fingerprint ON tabby_sync.conflicts;
CREATE TRIGGER conflicts_set_fingerprint
BEFORE INSERT OR UPDATE OF scope, object_type, object_id, local_payload, remote_payload
ON tabby_sync.conflicts
FOR EACH ROW EXECUTE FUNCTION tabby_sync.set_conflict_fingerprint();

UPDATE tabby_sync.conflicts
SET fingerprint = md5(concat_ws(E'\\x1f', scope, object_type, object_id,
    coalesce(local_payload::text, '<null>'),
    coalesce(remote_payload::text, '<null>')))
WHERE fingerprint IS NULL;

WITH ranked AS (
    SELECT id, row_number() OVER (
        PARTITION BY scope, object_type, object_id, fingerprint
        ORDER BY created_at DESC, id DESC
    ) AS position
    FROM tabby_sync.conflicts
)
DELETE FROM tabby_sync.conflicts AS conflict
USING ranked
WHERE conflict.id = ranked.id AND ranked.position > 1;

ALTER TABLE tabby_sync.conflicts ALTER COLUMN fingerprint SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conflicts_fingerprint_idx
    ON tabby_sync.conflicts (scope, object_type, object_id, fingerprint);

-- Recovery rows stay useful but bounded. Current objects are never removed;
-- only old conflict snapshots and long-observed deletion markers are pruned.
DELETE FROM tabby_sync.conflicts
WHERE resolved_at < clock_timestamp() - interval '30 days'
   OR (resolved_at IS NULL AND created_at < clock_timestamp() - interval '90 days');

WITH ranked AS (
    SELECT id, row_number() OVER (
        PARTITION BY scope, object_type, object_id
        ORDER BY created_at DESC, id DESC
    ) AS position
    FROM tabby_sync.conflicts
)
DELETE FROM tabby_sync.conflicts AS conflict
USING ranked
WHERE conflict.id = ranked.id AND ranked.position > 20;

DELETE FROM tabby_sync.objects
WHERE deleted_at < clock_timestamp() - interval '180 days';

-- After applying the migration, a dedicated runtime account needs only:
-- GRANT USAGE ON SCHEMA tabby_sync TO tabby_runtime;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON tabby_sync.objects, tabby_sync.conflicts TO tabby_runtime;
-- GRANT USAGE, SELECT ON SEQUENCE tabby_sync.conflicts_id_seq TO tabby_runtime;
