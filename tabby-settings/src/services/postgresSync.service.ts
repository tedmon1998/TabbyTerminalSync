import { Injectable } from '@angular/core'
import { ipcRenderer } from 'electron'
import { debounceTime } from 'rxjs'
import { AppService, ConfigService } from 'tabby-core'

export interface CommandTopic {
    id: string
    name: string
    description?: string
}

export interface CommandEntry {
    id: string
    topicId: string
    name: string
    description: string
    command: string
}

type EntityType = 'settings'|'profile'|'profile-group'|'command-topic'|'command'

interface SyncEntity {
    type: EntityType
    id: string
    payload: Record<string, any>|null
    updatedAt: string
    deleted?: boolean
    revision?: number
    pending?: boolean
}

interface Metadata {
    updatedAt: string
    deleted?: boolean
    snapshot?: Record<string, any>
    revision?: number
    pending?: boolean
}

interface Connection {
    host: string
    port: number
    database: string
    user: string
    ssl: boolean
}

interface SyncReply {
    entities: SyncEntity[]
    conflictCount: number
    syncedAt: string
}

interface TerminalTab {
    session: unknown
    sendInput: (input: string) => void
}

/** Synchronises all non-secret Tabby preferences, profiles/groups and the command library. */
@Injectable({ providedIn: 'root' })
export class PostgresSyncService {
    syncing = false
    online: boolean|null = null
    lastError = ''
    conflictCount = 0

    private applyingRemote = false
    private syncRequested = false
    private lastTerminal: TerminalTab|null = null

    constructor (private config: ConfigService, private app: AppService) {
        this.config.ready$.subscribe(() => this.initialize())
    }

    get lastSuccessfulSyncAt (): string {
        return this.config.store?.postgresSync?.lastSuccessfulSyncAt ?? ''
    }

    get lastAttemptAt (): string {
        return this.config.store?.postgresSync?.lastAttemptAt ?? ''
    }

    get pendingChangeCount (): number {
        return Object.values(this.metadata()).filter(state => state?.pending).length
    }

    get needsSynchronization (): boolean {
        return !this.lastSuccessfulSyncAt || this.pendingChangeCount > 0 || this.online === false
    }

    get connection (): Connection {
        const value = this.config.store.postgresSync
        return {
            host: value.host,
            port: Number(value.port),
            database: value.database,
            user: value.user,
            ssl: !!value.ssl,
        }
    }

    async savePassword (password: string): Promise<void> {
        if (!password) {
            return
        }
        await ipcRenderer.invoke('postgres-sync:save-password', this.connection, password)
        this.config.store.postgresSync.passwordSaved = true
        await this.config.save()
    }

    async getPassword (): Promise<string> {
        return ipcRenderer.invoke('postgres-sync:get-password', this.connection)
    }

    async clearPassword (): Promise<void> {
        await ipcRenderer.invoke('postgres-sync:clear-password', this.connection)
        this.config.store.postgresSync.passwordSaved = false
        await this.config.save()
    }

    async test (): Promise<void> {
        try {
            await ipcRenderer.invoke('postgres-sync:test', this.connection)
            this.online = true
            this.lastError = ''
        } catch (error) {
            this.online = false
            this.lastError = this.describeError(error)
            throw new Error(this.lastError)
        }
    }

    async sync (manual: boolean): Promise<boolean> {
        if (this.syncing) {
            this.syncRequested = true
            return false
        }
        if (!this.isConfigured()) {
            if (manual) {
                this.online = null
                this.lastError = 'Configure PostgreSQL and save its password before synchronizing.'
            }
            return false
        }
        if (!manual && (!this.config.store.postgresSync.enabled || !this.config.store.postgresSync.autoSync)) {
            return false
        }
        this.syncing = true
        this.syncRequested = false
        const attemptedAt = new Date().toISOString()
        try {
            this.captureLocalChanges()
            this.config.store.postgresSync.lastAttemptAt = attemptedAt
            await this.saveWithoutQueuing()
            const connectionFingerprint = this.connectionFingerprint()
            const sentEntities = this.entitiesForSync()
            const reply: SyncReply = await ipcRenderer.invoke('postgres-sync:sync', {
                connection: this.connection,
                deviceID: this.config.store.postgresSync.deviceID,
                initial: !this.config.store.postgresSync.initialized || this.config.store.postgresSync.connectionFingerprint !== connectionFingerprint,
                entities: sentEntities,
            })
            this.config.store.postgresSync.initialized = true
            this.config.store.postgresSync.connectionFingerprint = connectionFingerprint
            this.config.store.postgresSync.lastSuccessfulSyncAt = reply.syncedAt
            await this.applyRemote(reply.entities, sentEntities)
            this.conflictCount = reply.conflictCount
            this.online = true
            this.lastError = ''
            return true
        } catch (error) {
            this.online = false
            this.lastError = this.describeError(error)
            this.config.store.postgresSync.lastAttemptAt = attemptedAt
            await this.saveWithoutQueuing().catch(() => undefined)
            // Local changes are retained in the config metadata and retried on
            // the next interval or immediately by the Sync button.
            return false
        } finally {
            this.syncing = false
            const repeat = this.consumeSyncRequest()
            if (repeat && this.config.store.postgresSync.enabled && this.config.store.postgresSync.autoSync) {
                setTimeout(() => this.sync(false), 0)
            }
        }
    }

    executeInActiveTerminal (command: string): boolean {
        const active = this.app.activeTab
        const candidate = this.isTerminalTab(active)
            ? active
            : this.lastTerminal ?? this.app.tabs.find(tab => this.isTerminalTab(tab))
        if (!this.isTerminalTab(candidate)) {
            return false
        }
        candidate.sendInput(command.endsWith('\n') ? command : `${command}\n`)
        return true
    }

    private async initialize (): Promise<void> {
        this.applyingRemote = true
        try {
            let mustSave = false
            if (!this.config.store.postgresSync.deviceID) {
                this.config.store.postgresSync.deviceID = this.newID()
                mustSave = true
            }
            mustSave = this.captureLocalChanges() || mustSave
            if (mustSave) {
                await this.config.save()
            }
        } finally {
            this.applyingRemote = false
        }

        this.config.changed$.pipe(debounceTime(600)).subscribe(() => this.onConfigChanged())
        this.app.activeTabChange$.subscribe(tab => {
            if (this.isTerminalTab(tab)) {
                this.lastTerminal = tab
            }
        })
        setInterval(() => this.sync(false), 30000)
        if (this.config.store.postgresSync.enabled && this.config.store.postgresSync.autoSync) {
            setTimeout(() => this.sync(false), 0)
        }
    }

    private onConfigChanged (): void {
        if (this.applyingRemote) {
            return
        }
        if (!this.captureLocalChanges()) {
            return
        }
        if (this.syncing) {
            this.syncRequested = true
        }
        this.saveWithoutQueuing().then(() => {
            if (!this.syncing && this.config.store.postgresSync.enabled && this.config.store.postgresSync.autoSync) {
                this.sync(false)
            }
        }).catch(error => {
            this.online = false
            this.lastError = `Could not persist synchronization metadata: ${this.describeError(error)}`
        })
    }

    private isConfigured (): boolean {
        const c = this.connection
        return !!(c.host && c.database && c.user && c.port && this.config.store.postgresSync.passwordSaved)
    }

    private describeError (error: any): string {
        return String(error?.cause?.message ?? error?.message ?? error ?? 'Unknown PostgreSQL error')
            .replace(/^Error invoking remote method '[^']+':\s*/i, '')
            .replace(/^Error:\s*/i, '')
    }

    private connectionFingerprint (): string {
        const connection = this.connection
        return `${connection.user}@${connection.host}:${connection.port}/${connection.database}?ssl=${connection.ssl}`
    }

    private currentEntities (): Map<string, Record<string, any>> {
        const result = new Map<string, Record<string, any>>()
        const add = (type: EntityType, items: any[]) => {
            for (const item of items) {
                if (item?.id) {
                    const payload = type === 'profile' ? this.sanitizeProfile(item) : this.clone(item)
                    result.set(`${type}:${item.id}`, { type, payload })
                }
            }
        }
        add('profile', this.config.store.profiles ?? [])
        add('profile-group', this.config.store.groups ?? [])
        add('command-topic', this.config.store.postgresSync.commandTopics ?? [])
        add('command', this.config.store.postgresSync.commands ?? [])
        result.set('settings:global', { type: 'settings', payload: this.sanitizeSettings(this.config.store) })
        return result
    }

    private captureLocalChanges (): boolean {
        const current = this.currentEntities()
        const metadata = this.metadata()
        const now = new Date().toISOString()
        let changed = false
        for (const [key, entity] of current) {
            const state = metadata[key]
            if (!state?.snapshot || state.deleted === true || !this.equal(state.snapshot, entity.payload)) {
                metadata[key] = {
                    updatedAt: now,
                    snapshot: entity.payload,
                    revision: state ? state.revision : undefined,
                    pending: true,
                }
                changed = true
            }
        }
        for (const [key, state] of Object.entries(metadata)) {
            if (state && !current.has(key) && !state.deleted) {
                metadata[key] = {
                    ...state,
                    updatedAt: now,
                    deleted: true,
                    pending: true,
                }
                changed = true
            }
        }
        this.config.store.postgresSync.metadata = metadata
        return changed
    }

    private entitiesForSync (): SyncEntity[] {
        const current = this.currentEntities()
        const metadata = this.metadata()
        const result: SyncEntity[] = []
        for (const [key, entity] of current) {
            const state = metadata[key] ?? { updatedAt: new Date().toISOString() }
            result.push({
                type: entity.type,
                id: key.substring(key.indexOf(':') + 1),
                payload: entity.payload,
                updatedAt: state.updatedAt,
                revision: state.revision,
                pending: !!state.pending,
            })
        }
        for (const [key, state] of Object.entries(metadata)) {
            if (state?.deleted && !current.has(key)) {
                const [type, ...id] = key.split(':')
                result.push({
                    type: type as EntityType,
                    id: id.join(':'),
                    payload: null,
                    updatedAt: state.updatedAt,
                    deleted: true,
                    revision: state.revision,
                    pending: !!state.pending,
                })
            }
        }
        return result
    }

    private async applyRemote (entities: SyncEntity[], sentEntities: SyncEntity[]): Promise<void> {
        const concurrentChanges = this.changesSince(sentEntities)
        const localMetadata = this.clone(this.metadata())
        const localProfiles = new Map((this.config.store.profiles ?? []).map(profile => [profile.id, this.clone(profile)]))
        const byType = (type: EntityType) => entities
            .filter(entity => entity.type === type && !entity.deleted)
            .map(entity => type === 'profile' ? this.sanitizeProfile(entity.payload) : this.clone(entity.payload))
        const metadata: Record<string, Metadata|undefined> = {}
        for (const entity of entities) {
            metadata[`${entity.type}:${entity.id}`] = {
                updatedAt: entity.updatedAt,
                deleted: entity.deleted,
                snapshot: entity.deleted ? undefined : this.clone(entity.payload ?? {}),
                revision: entity.revision,
                pending: false,
            }
        }
        this.applyingRemote = true
        try {
            const globalSettings = byType('settings')[0]
            if (globalSettings) {
                this.applyGlobalSettings(globalSettings)
            }
            this.config.store.profiles = byType('profile').map(profile => this.restoreLocalSecrets(profile, localProfiles.get((profile as any)?.id)))
            this.config.store.groups = byType('profile-group')
            this.config.store.postgresSync.commandTopics = byType('command-topic')
            this.config.store.postgresSync.commands = byType('command')
            this.applyConcurrentChanges(concurrentChanges, localProfiles)
            const now = new Date().toISOString()
            for (const [key, entity] of concurrentChanges) {
                const prior = localMetadata[key]
                metadata[key] = {
                    updatedAt: prior?.pending ? prior.updatedAt : now,
                    deleted: entity.deleted,
                    snapshot: entity.deleted ? undefined : this.clone(entity.payload ?? {}),
                    revision: metadata[key]?.revision ?? prior?.revision,
                    pending: true,
                }
            }
            this.config.store.postgresSync.metadata = metadata
            await this.config.save()
        } finally {
            this.applyingRemote = false
        }
        if (this.captureLocalChanges()) {
            this.syncRequested = true
            await this.saveWithoutQueuing()
        }
    }

    /** Returns edits made while the database request was in flight. */
    private changesSince (sentEntities: SyncEntity[]): Map<string, SyncEntity> {
        const sent = new Map(sentEntities.map(entity => [this.entityKey(entity), entity]))
        const current = this.currentEntities()
        const result = new Map<string, SyncEntity>()
        const now = new Date().toISOString()

        for (const [key, entity] of current) {
            const before = sent.get(key)
            if (before === undefined || before.deleted === true || !this.equal(before.payload, entity.payload)) {
                result.set(key, {
                    type: entity.type,
                    id: key.substring(key.indexOf(':') + 1),
                    payload: this.clone(entity.payload),
                    updatedAt: now,
                    pending: true,
                })
            }
        }
        for (const [key, before] of sent) {
            if (!before.deleted && !current.has(key)) {
                result.set(key, {
                    type: before.type,
                    id: before.id,
                    payload: null,
                    updatedAt: now,
                    deleted: true,
                    pending: true,
                })
            }
        }
        return result
    }

    private applyConcurrentChanges (changes: Map<string, SyncEntity>, localProfiles: Map<any, any>): void {
        for (const entity of changes.values()) {
            if (entity.type === 'settings') {
                if (!entity.deleted && entity.payload) {
                    this.applyGlobalSettings(entity.payload)
                }
                continue
            }

            let collection: any[] = []
            switch (entity.type) {
                case 'profile':
                    collection = this.config.store.profiles ?? []
                    break
                case 'profile-group':
                    collection = this.config.store.groups ?? []
                    break
                case 'command-topic':
                    collection = this.config.store.postgresSync.commandTopics ?? []
                    break
                case 'command':
                    collection = this.config.store.postgresSync.commands ?? []
                    break
            }

            const next = collection.filter(item => item?.id !== entity.id)
            if (!entity.deleted && entity.payload) {
                const payload = entity.type === 'profile'
                    ? this.restoreLocalSecrets(entity.payload, localProfiles.get(entity.id))
                    : this.clone(entity.payload)
                next.push(payload)
            }
            switch (entity.type) {
                case 'profile':
                    this.config.store.profiles = next
                    break
                case 'profile-group':
                    this.config.store.groups = next
                    break
                case 'command-topic':
                    this.config.store.postgresSync.commandTopics = next
                    break
                case 'command':
                    this.config.store.postgresSync.commands = next
                    break
            }
        }
    }

    private entityKey (entity: Pick<SyncEntity, 'type'|'id'>): string {
        return `${entity.type}:${entity.id}`
    }

    private async saveWithoutQueuing (): Promise<void> {
        const wasApplyingRemote = this.applyingRemote
        this.applyingRemote = true
        try {
            await this.config.save()
        } finally {
            this.applyingRemote = wasApplyingRemote
        }
    }

    private consumeSyncRequest (): boolean {
        const requested = this.syncRequested
        this.syncRequested = false
        return requested
    }

    private isTerminalTab (value: unknown): value is TerminalTab {
        if (!value || typeof value !== 'object') {
            return false
        }
        const tab = value as Partial<TerminalTab>
        return !!tab.session && typeof tab.sendInput === 'function'
    }

    private metadata (): Record<string, Metadata|undefined> {
        const value = this.config.store.postgresSync.metadata
        return value && !Array.isArray(value) ? value : {}
    }

    private clone<T> (value: T): T {
        return JSON.parse(JSON.stringify(value))
    }

    private equal (a: any, b: any): boolean {
        return JSON.stringify(a) === JSON.stringify(b)
    }

    /** Secrets belong to Tabby's vault/keychain, never to PostgreSQL JSON. */
    private sanitizeProfile<T> (value: T): T {
        const copy = this.clone(value)
        const removeSecrets = object => {
            if (!object || typeof object !== 'object') { return }
            for (const key of Object.keys(object)) {
                if (['password', 'passphrase', 'secret', 'token', 'privateKeyPassphrase'].includes(key)) {
                    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                    delete object[key]
                } else {
                    removeSecrets(object[key])
                }
            }
        }
        removeSecrets(copy)
        return copy
    }

    /**
     * Remote profile JSON deliberately omits credentials. Re-applying it must
     * therefore never erase a password/passphrase that only exists locally.
     */
    private restoreLocalSecrets<T> (remote: T, local: any): T {
        const result: any = this.clone(remote)
        const secretKeys = new Set(['password', 'passphrase', 'secret', 'token', 'privateKeyPassphrase'])
        const visit = (target: any, source: any) => {
            if (!source || typeof source !== 'object' || Array.isArray(source)) { return }
            for (const [key, value] of Object.entries(source)) {
                if (secretKeys.has(key)) {
                    target[key] = this.clone(value)
                } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                    target[key] ??= {}
                    visit(target[key], value)
                }
            }
        }
        visit(result, local)
        return result
    }

    /**
     * A database connection is device-local bootstrap data: a fresh device
     * needs it before it can read PostgreSQL. The keychain/vault and sync
     * bookkeeping are likewise local. Everything else is regular shared UI,
     * terminal and plugin configuration.
     */
    private sanitizeSettings (value: any): Record<string, any> {
        const copy = this.clone(value)
        delete copy.profiles
        delete copy.groups
        delete copy.postgresSync
        delete copy.vault
        // Command history is intentionally device-local.  It can contain host
        // paths and operational details even after secret-line filtering.
        delete copy.commandHistory
        const removeSecrets = object => {
            if (!object || typeof object !== 'object') { return }
            for (const key of Object.keys(object)) {
                if (['password', 'passphrase', 'secret', 'token', 'apiKey', 'privateKeyPassphrase'].includes(key)) {
                    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                    delete object[key]
                } else {
                    removeSecrets(object[key])
                }
            }
        }
        removeSecrets(copy)
        return copy
    }

    private applyGlobalSettings (remote: Record<string, any>): void {
        const local = this.config.store
        const localConfigSyncToken = local.configSync?.token
        // Deep-merge rather than replace top-level plugin objects: shared
        // values take effect while local secret fields omitted from PostgreSQL
        // and newer plugin defaults remain intact.
        this.applySettingsObject(local, this.sanitizeSettings(remote))
        if (localConfigSyncToken) {
            local.configSync.token = localConfigSyncToken
        }
    }

    private applySettingsObject (target: any, source: any): void {
        for (const [key, value] of Object.entries(source ?? {})) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
                    target[key] = {}
                }
                this.applySettingsObject(target[key], value)
            } else {
                target[key] = this.clone(value)
            }
        }
    }

    private newID (): string {
        return `${Date.now()}-${Math.random().toString(36).substring(2)}`
    }
}
