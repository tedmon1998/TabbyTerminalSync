import { Component, Injector } from '@angular/core'
import deepClone from 'clone-deep'
import { BaseTabComponent } from './baseTab.component'
import { ProfilesService } from '../services/profiles.service'
import { ProfileGroup, PartialProfileGroup } from '../api/profileProvider'
import { AppService } from '../services/app.service'
import { VaultService, VaultFileSecret, VAULT_SECRET_TYPE_FILE } from '../services/vault.service'
import { NotificationsService } from '../services/notifications.service'
import { PlatformService } from '../api/platform'
import { CommandHistoryService } from '../services/commandHistory.service'

type Section = 'hosts'|'keychain'|'forwards'|'snippets'|'known-hosts'|'logs'|'workspaces'

/** A Termius-like operational home that works with the existing Tabby profile store. */
@Component({
    selector: 'vaults-tab',
    templateUrl: './vaultsTab.component.pug',
    styleUrls: ['./vaultsTab.component.scss'],
})
export class VaultsTabComponent extends BaseTabComponent {
    activeSection: Section = 'hosts'
    profiles: any[] = []
    profileGroups: PartialProfileGroup<ProfileGroup>[] = []
    selected: any|null = null
    editing: any|null = null
    selectedGroupID: string|null = null
    query = ''
    vaultFiles: VaultFileSecret[] = []
    detectedPrivateKeys: string[] = []
    passwordVisible = false
    loading = true
    private editorSaveTimer?: ReturnType<typeof setTimeout>
    private editorSaveChain = Promise.resolve()

    constructor (
        injector: Injector,
        private profilesService: ProfilesService,
        private app: AppService,
        private vault: VaultService,
        private notifications: NotificationsService,
        private platform: PlatformService,
        private commandHistory: CommandHistoryService,
    ) {
        super(injector)
        this.setTitle('Vaults')
        this.icon = 'fas fa-vault'
    }

    async ngOnInit (): Promise<void> {
        await this.refresh()
    }

    async refresh (): Promise<void> {
        this.loading = true
        try {
            const savedProfiles = (await this.profilesService.getProfiles()).filter((profile: any) => !profile.isTemplate && !profile.isBuiltin)
            // A restored Tabby session can exist even if its profile was not yet written
            // back into the visible config. Show it in Vaults instead of presenting a
            // misleading empty screen after migration.
            const restoredProfiles = (this.app.tabs as any[])
                .map(tab => tab?.profile)
                .filter(profile => profile && !profile.isTemplate && !profile.isBuiltin)
            const profilesById = new Map<string, any>()
            for (const profile of [...savedProfiles, ...restoredProfiles]) {
                profilesById.set(profile.id || `${profile.type}:${profile.name}`, profile)
            }
            this.profiles = [...profilesById.values()]
            this.profileGroups = await this.profilesService.getProfileGroups({ includeProfiles: false })
            // Vaults starts as a full-width browser. Details are opened only by
            // an explicit host selection, matching the expected Termius flow.
            if (this.selected && !profilesById.has(this.selected.id)) {
                this.selected = null
            }
            if (this.vault.isOpen()) {
                const contents = await this.vault.load()
                this.vaultFiles = (contents?.secrets ?? []).filter((secret: any) => secret.type === VAULT_SECRET_TYPE_FILE) as VaultFileSecret[]
            }
            this.detectedPrivateKeys = await window['nodeRequire']('electron').ipcRenderer.invoke('ssh-local:list-keys').catch(() => [])
        } finally {
            this.loading = false
        }
    }

    get filteredProfiles (): any[] {
        const query = this.query.trim().toLowerCase()
        return this.profiles
            .filter(profile => !this.selectedGroupID || (profile.group || 'ungrouped') === this.selectedGroupID)
            .filter(profile => !query || `${profile.name} ${profile.group ?? ''} ${profile.options?.host ?? ''} ${profile.options?.user ?? ''}`.toLowerCase().includes(query))
    }

    get groups (): { id: string, name: string, profiles: any[] }[] {
        const namedGroups = new Map(this.profileGroups.map(group => [group.id, group.name]))
        const groups = new Map<string, { id: string, name: string, profiles: any[] }>()
        const query = this.query.trim().toLowerCase()
        for (const profile of this.profiles.filter(item => !query || `${item.name} ${item.group ?? ''} ${item.options?.host ?? ''} ${item.options?.user ?? ''}`.toLowerCase().includes(query))) {
            const id = profile.group || 'ungrouped'
            const name = namedGroups.get(id) || (id === 'ungrouped' ? 'Ungrouped' : id)
            let group = groups.get(id)
            if (!group) {
                group = { id, name, profiles: [] as any[] }
            }
            group.profiles.push(profile)
            groups.set(id, group)
        }
        return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
    }

    get selectedGroupName (): string {
        return this.groups.find(group => group.id === this.selectedGroupID)?.name ?? 'Group'
    }

    selectGroup (group: { id: string }): void {
        this.selectedGroupID = group.id
        this.selected = null
        this.closeEditor()
    }

    clearGroup (): void {
        this.selectedGroupID = null
        this.selected = null
        this.closeEditor()
    }

    get forwardedRules (): { profile: any, rule: any }[] {
        return this.profiles.flatMap(profile => (profile.options?.forwardedPorts ?? []).map(rule => ({ profile, rule })))
    }

    get knownHosts (): any[] { return this.config.store?.ssh?.knownHosts ?? [] }
    get historyEntries (): any[] { return this.commandHistory.entries }
    get workspaceTabs (): any[] { return this.app.tabs.filter(tab => tab !== this) }

    selectSection (section: Section): void {
        if (section !== 'hosts') { this.closeEditor() }
        this.activeSection = section
    }

    async connect (profile: any): Promise<void> {
        await this.profilesService.launchProfile(profile)
    }

    openEditor (profile: any, event?: MouseEvent): void {
        event?.stopPropagation()
        this.selected = profile
        this.editing = deepClone(profile)
        this.passwordVisible = false
        this.editing.options ??= {}
        this.editing.options.privateKeys ??= []
    }

    async saveEditor (): Promise<void> {
        if (!this.editing?.name?.trim()) { return }
        if (this.editorSaveTimer) { clearTimeout(this.editorSaveTimer) }
        await this.persistEditorSnapshot(deepClone(this.editing))
        this.editing = null
        await this.refresh()
    }

    closeEditor (): void {
        if (this.editorSaveTimer) { clearTimeout(this.editorSaveTimer) }
        if (this.editing?.name?.trim()) {
            void this.persistEditorSnapshot(deepClone(this.editing))
        }
        this.editing = null
        this.passwordVisible = false
    }

    scheduleEditorSave (): void {
        if (!this.editing?.name?.trim()) { return }
        if (this.editorSaveTimer) { clearTimeout(this.editorSaveTimer) }
        const snapshot = deepClone(this.editing)
        this.editorSaveTimer = setTimeout(() => void this.persistEditorSnapshot(snapshot), 650)
    }

    async saveAndConnect (): Promise<void> {
        if (!this.editing) { return }
        const profile = deepClone(this.editing)
        await this.saveEditor()
        await this.connect(profile)
    }

    private async persistEditorSnapshot (profile: any): Promise<void> {
        profile.name = profile.name.trim()
        profile.options ??= {}
        profile.options.port = profile.options.port ? Number(profile.options.port) : 22
        this.editorSaveChain = this.editorSaveChain.then(async () => {
            await this.profilesService.writeProfile(profile)
            await this.config.save()
            const index = this.profiles.findIndex(item => item.id === profile.id)
            if (index !== -1) { this.profiles[index] = deepClone(profile) }
            if (this.selected?.id === profile.id) { this.selected = deepClone(profile) }
        }).catch(error => {
            this.notifications.error(error?.message ?? String(error), 'Could not save host')
        })
        await this.editorSaveChain
    }

    selectProfile (profile: any, event?: MouseEvent): void {
        event?.stopPropagation()
        this.selected = profile
    }

    /** Termius dismisses Host Details when the user clicks the free host canvas. */
    clearSelection (event: MouseEvent): void {
        const target = event.target as HTMLElement
        if (!target.closest('.host-card, .group-card')) {
            this.closeEditor()
            this.selected = null
        }
    }

    addDetectedPrivateKey (name: string): void {
        if (!this.editing) { return }
        const reference = `file://${process.env.HOME}/.ssh/${name}`
        const keys = this.editing.options.privateKeys ?? []
        if (!keys.includes(reference)) {
            this.editing.options.privateKeys = [...keys, reference]
            this.scheduleEditorSave()
        }
    }

    removePrivateKey (reference: string): void {
        if (!this.editing) { return }
        this.editing.options.privateKeys = (this.editing.options.privateKeys ?? []).filter(key => key !== reference)
        this.scheduleEditorSave()
    }

    async forgetKnownHost (knownHost: any): Promise<void> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `Forget the saved fingerprint for ${knownHost.host}:${knownHost.port}?`,
            detail: 'The host identity will be verified again on the next connection.',
            buttons: ['Forget', 'Cancel'], defaultId: 1, cancelId: 1,
        })
        if (result.response !== 0) { return }
        this.config.store.ssh.knownHosts = this.knownHosts.filter(item => item !== knownHost)
        await this.config.save()
    }

    async clearHistory (): Promise<void> {
        const result = await this.platform.showMessageBox({
            type: 'warning', message: 'Clear saved command history?',
            buttons: ['Clear', 'Cancel'], defaultId: 1, cancelId: 1,
        })
        if (result.response !== 0) { return }
        await this.commandHistory.clear()
    }

    selectWorkspaceTab (tab: any): void { this.app.selectTab(tab) }

    get hostSummary (): string {
        if (!this.selected) { return 'Select a host' }
        const options = this.selected.options ?? {}
        return options.host ? `${options.user ? `${options.user}@` : ''}${options.host}${options.port ? `:${options.port}` : ''}` : this.selected.type
    }

    async openSettings (tab: string): Promise<void> {
        try {
            const { SettingsTabComponent } = window['nodeRequire']('tabby-settings')
            this.app.openNewTabRaw({ type: SettingsTabComponent, inputs: { activeTab: tab } })
        } catch {
            this.notifications.error('Settings module is unavailable')
        }
    }

    /** Opens the standalone two-pane SFTP workspace without needing a terminal first. */
    async openSFTPWorkspace (): Promise<void> {
        try {
            const { SFTPWorkspaceTabComponent } = window['nodeRequire']('tabby-ssh')
            const existing = this.app.tabs.find(tab => tab instanceof SFTPWorkspaceTabComponent)
            if (existing) {
                this.app.selectTab(existing)
            } else {
                this.app.openNewTabRaw({ type: SFTPWorkspaceTabComponent })
            }
        } catch {
            this.notifications.error('SFTP module is unavailable')
        }
    }

}
