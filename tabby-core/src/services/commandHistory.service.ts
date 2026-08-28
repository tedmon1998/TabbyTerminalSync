import { Injectable, NgZone } from '@angular/core'
import { ipcRenderer } from 'electron'

import { ConfigService } from './config.service'

export interface CommandHistoryEntry {
    id: string
    command: string
    createdAt: string
    profile: string
}

/** Renderer facade for the local, non-synchronised command history file. */
@Injectable({ providedIn: 'root' })
export class CommandHistoryService {
    entries: CommandHistoryEntry[] = []
    private ready: Promise<void>

    constructor (private config: ConfigService, private zone: NgZone) {
        this.ready = this.load()
        ipcRenderer.on('command-history:changed', (_event, entries) => {
            this.zone.run(() => { this.entries = this.normalize(entries) })
        })
    }

    async add (command: string, profile: string): Promise<void> {
        await this.ready
        const entries = await ipcRenderer.invoke('command-history:add', {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            command,
            createdAt: new Date().toISOString(),
            profile,
        }, this.limit)
        this.zone.run(() => { this.entries = this.normalize(entries) })
    }

    async clear (): Promise<void> {
        await this.ready
        const entries = await ipcRenderer.invoke('command-history:clear')
        this.zone.run(() => { this.entries = this.normalize(entries) })
    }

    private async load (): Promise<void> {
        await this.config.ready$.toPromise()
        const legacyEntries = this.config.store.commandHistory?.entries ?? []
        const entries = await ipcRenderer.invoke('command-history:list', legacyEntries, this.limit)
        this.zone.run(() => { this.entries = this.normalize(entries) })
    }

    private normalize (value: unknown): CommandHistoryEntry[] {
        return Array.isArray(value) ? value.filter(entry => typeof entry?.command === 'string') : []
    }

    private get limit (): number {
        return Math.max(50, Math.min(1000, Number(this.config.store.commandHistory?.limit) || 500))
    }
}
