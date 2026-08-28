import * as keytar from 'keytar'
import { Pool, PoolConfig } from 'pg'

export interface PostgresConnection {
    host: string
    port: number
    database: string
    user: string
    ssl: boolean
}

export interface SyncEntity {
    type: 'settings'|'profile'|'profile-group'|'command-topic'|'command'
    id: string
    payload: Record<string, any>|null
    updatedAt: string
    deleted?: boolean
    revision?: number
    pending?: boolean
}

export interface SyncRequest {
    connection: PostgresConnection
    deviceID: string
    initial: boolean
    entities: SyncEntity[]
}

interface StoredEntity extends SyncEntity {
    revision: number
}

const KEYTAR_SERVICE = 'Tabby PostgreSQL sync'

/**
 * Runs only in Electron's main process. The renderer never receives the
 * database password and can only call the narrowly scoped IPC handlers below.
 */
export class PostgresSyncService {
    private readonly migrationSQL = `
        CREATE SCHEMA IF NOT EXISTS tabby_sync;
        CREATE TABLE IF NOT EXISTS tabby_sync.objects (
            scope text NOT NULL DEFAULT 'default',
            object_type text NOT NULL,
            CONSTRAINT objects_type_check CHECK (object_type IN ('settings', 'profile', 'profile-group', 'command-topic', 'command')),
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
            fingerprint text NOT NULL
        );
        CREATE INDEX IF NOT EXISTS objects_updated_at_idx ON tabby_sync.objects (scope, updated_at);
        CREATE INDEX IF NOT EXISTS conflicts_open_idx ON tabby_sync.conflicts (scope, resolved_at) WHERE resolved_at IS NULL;
        CREATE INDEX IF NOT EXISTS conflicts_retention_idx ON tabby_sync.conflicts (scope, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS conflicts_fingerprint_idx
            ON tabby_sync.conflicts (scope, object_type, object_id, fingerprint);
    `

    async savePassword (connection: PostgresConnection, password: string): Promise<void> {
        if (!password) {
            return
        }
        this.validate(connection)
        await keytar.setPassword(KEYTAR_SERVICE, this.account(connection), password)
    }

    async hasPassword (connection: PostgresConnection): Promise<boolean> {
        this.validate(connection)
        const password = await keytar.getPassword(KEYTAR_SERVICE, this.account(connection))
        return !!password
    }

    async getPassword (connection: PostgresConnection): Promise<string> {
        this.validate(connection)
        return await keytar.getPassword(KEYTAR_SERVICE, this.account(connection)) ?? ''
    }

    async clearPassword (connection: PostgresConnection): Promise<void> {
        this.validate(connection)
        await keytar.deletePassword(KEYTAR_SERVICE, this.account(connection))
    }

    async test (connection: PostgresConnection): Promise<void> {
        const pool = await this.open(connection)
        const client = await pool.connect()
        try {
            // Test is also the bootstrap action. A user should never have to
            // copy the migration into psql manually before the first sync.
            await client.query('BEGIN')
            const removed = await this.ensureMigration(client) + await this.prune(client)
            await client.query('COMMIT')
            await this.reclaimSpace(client, removed)
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined)
            throw this.describeConnectionError(error, connection)
        } finally {
            client.release()
            await pool.end()
        }
    }

    async sync (request: SyncRequest): Promise<{ entities: StoredEntity[], conflictCount: number, syncedAt: string }> {
        const pool = await this.open(request.connection)
        const client = await pool.connect()
        try {
            await client.query('BEGIN')
            const migratedRows = await this.ensureMigration(client)

            for (const entity of request.entities) {
                await this.mergeEntity(client, entity, request)
            }

            const removedRows = migratedRows + await this.prune(client)

            const { rows } = await client.query(
                `SELECT object_type, object_id, payload, revision, updated_at, deleted_at
                 FROM tabby_sync.objects WHERE scope = 'default'`,
            )
            const conflicts = await client.query(
                `SELECT count(*)::int AS count FROM tabby_sync.conflicts WHERE scope = 'default' AND resolved_at IS NULL`,
            )
            const clock = await client.query('SELECT clock_timestamp() AS synced_at')
            await client.query('COMMIT')
            await this.reclaimSpace(client, removedRows)
            return {
                entities: rows.map(row => ({
                    type: row.object_type,
                    id: row.object_id,
                    payload: row.payload,
                    revision: Number(row.revision),
                    updatedAt: new Date(row.updated_at).toISOString(),
                    deleted: !!row.deleted_at,
                })),
                conflictCount: conflicts.rows[0].count,
                syncedAt: new Date(clock.rows[0].synced_at).toISOString(),
            }
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined)
            throw this.describeConnectionError(error, request.connection)
        } finally {
            client.release()
            await pool.end()
        }
    }

    private async mergeEntity (client: any, local: SyncEntity, request: SyncRequest): Promise<void> {
        const result = await client.query(
            `SELECT payload, revision, updated_at, updated_by, deleted_at
             FROM tabby_sync.objects
             WHERE scope = 'default' AND object_type = $1 AND object_id = $2 FOR UPDATE`,
            [local.type, local.id],
        )
        const remote = result.rows[0]
        const localUpdated = new Date(local.updatedAt)

        if (!remote) {
            // A clean entity which vanished from PostgreSQL was either deleted
            // and its tombstone later expired, or removed administratively. It
            // must not be resurrected by an old client. Brand-new local rows
            // are always pending and still take the normal INSERT path.
            if (!request.initial && local.pending === false) {
                return
            }
            await client.query(
                `INSERT INTO tabby_sync.objects
                    (scope, object_type, object_id, payload, revision, updated_at, updated_by, deleted_at)
                 VALUES ('default', $1, $2, $3, 1, clock_timestamp(), $4,
                    CASE WHEN $5 THEN clock_timestamp() ELSE NULL END)`,
                [local.type, local.id, local.payload, request.deviceID, !!local.deleted],
            )
            return
        }

        const remoteUpdated = new Date(remote.updated_at)
        const payloadChanged = JSON.stringify(remote.payload) !== JSON.stringify(local.payload)
            || Boolean(remote.deleted_at) !== Boolean(local.deleted)
        if (!payloadChanged) {
            return
        }

        // A clean local copy that differs from PostgreSQL simply means that
        // another device changed it. Pull that row without manufacturing a
        // conflict or overwriting it with stale data.
        if (!request.initial && local.pending === false) {
            return
        }

        // On the first pull, an existing database row is authoritative. Later
        // changes based on the current revision can be applied without relying
        // on wall clocks. Concurrent edits fall back to deterministic LWW,
        // while the losing version is always saved for recovery/audit.
        const basedOnCurrentRevision = Number.isInteger(local.revision) && local.revision === Number(remote.revision)
        const timestampWins = localUpdated.getTime() > remoteUpdated.getTime()
            || localUpdated.getTime() === remoteUpdated.getTime() && request.deviceID > String(remote.updated_by)
        const localWins = !request.initial && (basedOnCurrentRevision || timestampWins)
        if (localWins) {
            if (!basedOnCurrentRevision) {
                await this.recordConflict(client, local, remote.payload, localUpdated, remoteUpdated)
            }
            await client.query(
                `UPDATE tabby_sync.objects SET payload = $3, revision = revision + 1,
                    updated_at = clock_timestamp(), updated_by = $4,
                    deleted_at = CASE WHEN $5 THEN clock_timestamp() ELSE NULL END
                 WHERE scope = 'default' AND object_type = $1 AND object_id = $2`,
                [local.type, local.id, local.payload, request.deviceID, !!local.deleted],
            )
        } else {
            await this.recordConflict(client, local, remote.payload, localUpdated, remoteUpdated)
        }
    }

    private async recordConflict (client: any, local: SyncEntity, remotePayload: unknown, localUpdated: Date, remoteUpdated: Date): Promise<void> {
        // fingerprint is generated from the canonical jsonb payloads. The
        // unique index makes this operation idempotent across reconnects,
        // repeated timers and multiple clients.
        await client.query(
            `INSERT INTO tabby_sync.conflicts
                (scope, object_type, object_id, local_payload, remote_payload, local_updated_at, remote_updated_at)
             VALUES ('default', $1, $2, $3, $4, $5, $6)
             ON CONFLICT (scope, object_type, object_id, fingerprint) DO NOTHING`,
            [local.type, local.id, local.payload, remotePayload, localUpdated, remoteUpdated],
        )
    }

    private async ensureMigration (client: any): Promise<number> {
        const result = await client.query(
            `SELECT to_regclass('tabby_sync.objects') AS objects, to_regclass('tabby_sync.conflicts') AS conflicts`,
        )
        if (!result.rows[0].objects || !result.rows[0].conflicts) {
            await client.query(this.migrationSQL)
        }
        // Older builds had a four-value CHECK constraint. Upgrade it in place
        // without dropping objects or user data before syncing global settings.
        const constraints = await client.query(
            `SELECT conname, pg_get_constraintdef(oid) AS definition
             FROM pg_constraint WHERE conrelid = 'tabby_sync.objects'::regclass AND contype = 'c'`,
        )
        const typeConstraint = constraints.rows.find(row => row.definition.includes('object_type'))
        if (typeConstraint && !typeConstraint.definition.includes('\'settings\'')) {
            const name = String(typeConstraint.conname).replace(/"/g, '""')
            await client.query(`ALTER TABLE tabby_sync.objects DROP CONSTRAINT "${name}"`)
            await client.query(`ALTER TABLE tabby_sync.objects ADD CONSTRAINT objects_type_check CHECK (object_type IN ('settings', 'profile', 'profile-group', 'command-topic', 'command'))`)
        }

        const fingerprintColumn = await client.query(`
            SELECT a.attnotnull
            FROM pg_attribute AS a
            WHERE a.attrelid = 'tabby_sync.conflicts'::regclass
              AND a.attname = 'fingerprint' AND NOT a.attisdropped
        `)
        if (!fingerprintColumn.rowCount) {
            await client.query('ALTER TABLE tabby_sync.conflicts ADD COLUMN fingerprint text')
        }
        const fingerprintTrigger = await client.query(`
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'tabby_sync.conflicts'::regclass
              AND tgname = 'conflicts_set_fingerprint' AND NOT tgisinternal
        `)
        if (!fingerprintTrigger.rowCount) {
            // A trigger keeps the schema compatible with an older Tabby build
            // that still inserts the original conflict column set.
            await client.query(`
                CREATE OR REPLACE FUNCTION tabby_sync.set_conflict_fingerprint()
                RETURNS trigger LANGUAGE plpgsql AS $function$
                BEGIN
                    NEW.fingerprint := md5(concat_ws(E'\\x1f', NEW.scope, NEW.object_type, NEW.object_id,
                        coalesce(NEW.local_payload::text, '<null>'),
                        coalesce(NEW.remote_payload::text, '<null>')));
                    IF TG_OP = 'INSERT' THEN
                        -- Serialize the same payload pair so even two legacy
                        -- clients without ON CONFLICT cannot race each other.
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
                $function$
            `)
            await client.query(`
                CREATE TRIGGER conflicts_set_fingerprint
                BEFORE INSERT OR UPDATE OF scope, object_type, object_id, local_payload, remote_payload
                ON tabby_sync.conflicts
                FOR EACH ROW EXECUTE FUNCTION tabby_sync.set_conflict_fingerprint()
            `)
        }
        await client.query(`
            UPDATE tabby_sync.conflicts
            SET fingerprint = md5(concat_ws(E'\\x1f', scope, object_type, object_id,
                coalesce(local_payload::text, '<null>'),
                coalesce(remote_payload::text, '<null>')))
            WHERE fingerprint IS NULL
        `)

        // Upgrade old installations in place. Existing duplicate rows are
        // byte-for-byte recovery copies, so keeping the newest one preserves
        // all distinct versions while immediately removing the database bloat.
        const duplicates = await client.query(`
            WITH ranked AS (
                SELECT id, row_number() OVER (
                    PARTITION BY scope, object_type, object_id, fingerprint
                    ORDER BY created_at DESC, id DESC
                ) AS position
                FROM tabby_sync.conflicts
            )
            DELETE FROM tabby_sync.conflicts AS conflict
            USING ranked
            WHERE conflict.id = ranked.id AND ranked.position > 1
        `)
        if (!fingerprintColumn.rows[0]?.attnotnull) {
            await client.query('ALTER TABLE tabby_sync.conflicts ALTER COLUMN fingerprint SET NOT NULL')
        }
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS conflicts_fingerprint_idx
                ON tabby_sync.conflicts (scope, object_type, object_id, fingerprint)
        `)
        await client.query(`
            CREATE INDEX IF NOT EXISTS conflicts_retention_idx
                ON tabby_sync.conflicts (scope, created_at)
        `)
        return duplicates.rowCount ?? 0
    }

    /**
     * Keeps recovery data useful but bounded. Active objects are never pruned.
     * Tombstones get a long grace period so normally-offline devices observe
     * deletions before those compact marker rows are removed.
     */
    private async prune (client: any): Promise<number> {
        const expiredConflicts = await client.query(`
            DELETE FROM tabby_sync.conflicts
            WHERE resolved_at < clock_timestamp() - interval '30 days'
               OR (resolved_at IS NULL AND created_at < clock_timestamp() - interval '90 days')
        `)
        const excessConflicts = await client.query(`
            WITH ranked AS (
                SELECT id, row_number() OVER (
                    PARTITION BY scope, object_type, object_id
                    ORDER BY created_at DESC, id DESC
                ) AS position
                FROM tabby_sync.conflicts
            )
            DELETE FROM tabby_sync.conflicts AS conflict
            USING ranked
            WHERE conflict.id = ranked.id AND ranked.position > 20
        `)
        const expiredTombstones = await client.query(`
            DELETE FROM tabby_sync.objects
            WHERE deleted_at < clock_timestamp() - interval '180 days'
        `)
        return (expiredConflicts.rowCount ?? 0) + (excessConflicts.rowCount ?? 0) + (expiredTombstones.rowCount ?? 0)
    }

    private async reclaimSpace (client: any, removedRows: number): Promise<void> {
        if (removedRows < 100) {
            return
        }
        // DELETE already makes pages reusable. VACUUM returns a one-off large
        // duplicate incident to the operating system where the database role
        // owns the table; lack of VACUUM permission must never fail sync.
        await client.query('VACUUM (ANALYZE) tabby_sync.conflicts').catch(() => undefined)
        await client.query('VACUUM (ANALYZE) tabby_sync.objects').catch(() => undefined)
    }

    private async open (connection: PostgresConnection): Promise<Pool> {
        this.validate(connection)
        const password = await keytar.getPassword(KEYTAR_SERVICE, this.account(connection))
        if (!password) {
            throw new Error('PostgreSQL password is not saved. Enter it in Tabby settings first.')
        }
        const options = this.poolOptions(connection, password)
        let pool = new Pool(options)
        try {
            // pg pools are lazy. Probe here so a missing database can be
            // created before callers request their transactional client.
            await pool.query('SELECT 1')
            return pool
        } catch (error: any) {
            await pool.end().catch(() => undefined)
            if (error?.code !== '3D000') {
                throw this.describeConnectionError(error, connection)
            }
        }

        await this.createDatabase(connection, password)
        pool = new Pool(options)
        try {
            await pool.query('SELECT 1')
            return pool
        } catch (error) {
            await pool.end().catch(() => undefined)
            throw this.describeConnectionError(error, connection)
        }
    }

    private poolOptions (connection: PostgresConnection, password: string, database = connection.database): PoolConfig {
        const options: PoolConfig = {
            host: connection.host,
            port: Number(connection.port),
            database,
            user: connection.user,
            password,
            max: 1,
            connectionTimeoutMillis: 8000,
            statement_timeout: 15000,
        }
        if (connection.ssl) {
            options.ssl = { rejectUnauthorized: true }
        }
        return options
    }

    /** Creates only the requested database, and only after PostgreSQL reports 3D000. */
    private async createDatabase (connection: PostgresConnection, password: string): Promise<void> {
        const maintenanceDatabases = ['postgres', 'template1'].filter(database => database !== connection.database)
        let lastError: any = null
        for (const database of maintenanceDatabases) {
            const pool = new Pool(this.poolOptions(connection, password, database))
            try {
                const existing = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [connection.database])
                if (!existing.rowCount) {
                    await pool.query(`CREATE DATABASE ${this.quoteIdentifier(connection.database)}`)
                }
                return
            } catch (error: any) {
                lastError = error
                if (error?.code === '3D000') { continue }
                if (error?.code === '42501') {
                    throw new Error(`Database “${connection.database}” does not exist and PostgreSQL user “${connection.user}” has no CREATEDB permission.`)
                }
                throw this.describeConnectionError(error, { ...connection, database })
            } finally {
                await pool.end().catch(() => undefined)
            }
        }
        throw this.describeConnectionError(lastError ?? new Error('No maintenance database is available.'), connection)
    }

    private quoteIdentifier (value: string): string {
        return `"${String(value).replace(/"/g, '""')}"`
    }

    private describeConnectionError (error: any, connection: PostgresConnection): Error {
        const message = String(error?.message ?? error ?? 'Unknown PostgreSQL error')
        if (message.startsWith('PostgreSQL ')) { return error }
        const endpoint = `${connection.host}:${connection.port}/${connection.database}`
        let detail = message
        if (/connection terminated unexpectedly|server closed the connection unexpectedly/i.test(message)) {
            detail = 'the TCP port accepted a connection but closed the PostgreSQL protocol handshake before authentication. Verify that this port forwards raw TCP to PostgreSQL (not through an HTTP/Nginx proxy) and inspect the PostgreSQL or TCP-proxy log.'
        } else if (error?.code === '28P01') {
            detail = `password authentication failed for user “${connection.user}”.`
        } else if (error?.code === '28000') {
            detail = `PostgreSQL rejected authentication for user “${connection.user}”. Check pg_hba.conf.`
        } else if (error?.code === '3D000') {
            detail = `database “${connection.database}” does not exist and could not be created automatically.`
        } else if (error?.code === 'ECONNREFUSED') {
            detail = 'connection refused. PostgreSQL is not listening on this address/port or a firewall rejected it.'
        } else if (error?.code === 'ETIMEDOUT' || /timeout/i.test(message)) {
            detail = 'connection timed out. Check routing, firewall and the published PostgreSQL port.'
        } else if (/certificate|self[- ]signed|unable to verify/i.test(message)) {
            detail = 'TLS certificate verification failed. Install a certificate valid for this host or disable verified TLS only on a trusted private network.'
        }
        const result: any = new Error(`PostgreSQL ${endpoint}: ${detail}`)
        result.code = error?.code
        return result
    }

    private validate (connection: PostgresConnection): void {
        if (!connection.host || !connection.database || !connection.user || !Number.isInteger(Number(connection.port)) || Number(connection.port) < 1 || Number(connection.port) > 65535) {
            throw new Error('PostgreSQL host, port, database and user are required.')
        }
    }

    private account (connection: PostgresConnection): string {
        return `${connection.user}@${connection.host}:${connection.port}/${connection.database}`
    }
}
