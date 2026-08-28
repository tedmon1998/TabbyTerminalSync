import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { writeFile } from 'atomically'

export interface LocalCommandHistoryEntry {
    id: string
    command: string
    createdAt: string
    profile: string
}

/**
 * Device-local command history.  It deliberately lives outside config.yaml so
 * PostgreSQL/config sync and vault locking cannot move or discard it.
 */
export class LocalCommandHistoryService {
    private operation: Promise<unknown> = Promise.resolve()

    async list (legacyEntries: unknown = [], requestedLimit: unknown = 500): Promise<LocalCommandHistoryEntry[]> {
        return this.serialized(async () => {
            const limit = this.limit(requestedLimit)
            const current = await this.read()
            const legacy = this.normalizeEntries(legacyEntries)
            const merged = this.merge(current, legacy).slice(0, limit)
            if (legacy.length || merged.length !== current.length) {
                await this.write(merged)
            }
            return merged
        })
    }

    async add (value: unknown, requestedLimit: unknown = 500): Promise<LocalCommandHistoryEntry[]> {
        return this.serialized(async () => {
            const entry = this.normalizeEntry(value)
            const entries = await this.read()
            if (!entry || entries[0]?.command === entry.command) {
                return entries.slice(0, this.limit(requestedLimit))
            }
            const result = [entry, ...entries].slice(0, this.limit(requestedLimit))
            await this.write(result)
            return result
        })
    }

    async clear (): Promise<LocalCommandHistoryEntry[]> {
        return this.serialized(async () => {
            await this.write([])
            return []
        })
    }

    private serialized<T> (action: () => Promise<T>): Promise<T> {
        const result = this.operation.then(action, action)
        this.operation = result.then(() => undefined, () => undefined)
        return result
    }

    private async read (): Promise<LocalCommandHistoryEntry[]> {
        try {
            const document = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'))
            return this.normalizeEntries(document?.entries)
        } catch (error: any) {
            if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
                throw error
            }
            return []
        }
    }

    private async write (entries: LocalCommandHistoryEntry[]): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
        await writeFile(this.filePath, JSON.stringify({ version: 1, entries }, null, 2), {
            encoding: 'utf8',
            mode: 0o600,
        })
        await fs.promises.chmod(this.filePath, 0o600).catch(() => undefined)
    }

    private normalizeEntries (value: unknown): LocalCommandHistoryEntry[] {
        if (!Array.isArray(value)) { return [] }
        const result: LocalCommandHistoryEntry[] = []
        const ids = new Set<string>()
        for (const candidate of value) {
            const entry = this.normalizeEntry(candidate)
            if (entry && !ids.has(entry.id)) {
                ids.add(entry.id)
                result.push(entry)
            }
        }
        return result.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    }

    private normalizeEntry (value: any): LocalCommandHistoryEntry|null {
        const command = typeof value?.command === 'string' ? value.command.trim().slice(0, 4096) : ''
        const lower = command.toLowerCase()
        if (!command || /[\x00-\x08\x0e-\x1f]/.test(command)
            || /\b(password|passphrase|token|secret|api[_-]?key|private[_-]?key)\b\s*[=:]/.test(lower)
            || /sshpass|authorization:\s*bearer/.test(lower)) {
            return null
        }
        const createdAt = Number.isFinite(Date.parse(value?.createdAt))
            ? new Date(value.createdAt).toISOString()
            : new Date().toISOString()
        return {
            id: typeof value?.id === 'string' && value.id ? value.id.slice(0, 160) : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            command,
            createdAt,
            profile: typeof value?.profile === 'string' && value.profile.trim() ? value.profile.trim().slice(0, 256) : 'Terminal',
        }
    }

    private merge (primary: LocalCommandHistoryEntry[], secondary: LocalCommandHistoryEntry[]): LocalCommandHistoryEntry[] {
        return this.normalizeEntries([...primary, ...secondary])
    }

    private limit (value: unknown): number {
        return Math.max(50, Math.min(1000, Number(value) || 500))
    }

    private get filePath (): string {
        return path.join(app.getPath('userData'), 'command-history.json')
    }
}
