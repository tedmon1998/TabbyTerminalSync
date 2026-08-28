import { Component, EventEmitter, Injector, Input, OnDestroy, Output } from '@angular/core'
import { ipcRenderer } from 'electron'
import { FileUpload, NotificationsService, PlatformService, ProfilesService, PromptModalComponent } from 'tabby-core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { posix as posixPath } from 'path'
import * as russh from 'russh'

import { SFTPSession } from '../session/sftp'
import { SSHSession } from '../session/ssh'

interface WorkspaceFile {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    size: number
    modified: Date
    mode: number
}

class MemoryFileUpload extends FileUpload {
    private offset = 0

    constructor (private name: string, private bytes: Uint8Array, private mode = 0o644) { super() }

    getName (): string { return this.name }
    getSize (): number { return this.bytes.length }
    getMode (): number { return this.mode }
    close (): void { this.offset = this.bytes.length }

    async read (): Promise<Uint8Array> {
        if (this.offset >= this.bytes.length) { return new Uint8Array(0) }
        const end = Math.min(this.offset + 256 * 1024, this.bytes.length)
        const chunk = this.bytes.slice(this.offset, end)
        this.offset = end
        return chunk
    }
}

/** One independently selectable side of the Termius-style SFTP workspace. */
@Component({
    selector: 'sftp-workspace-pane',
    templateUrl: './sftpWorkspacePane.component.pug',
    styleUrls: ['./sftpWorkspacePane.component.scss'],
})
export class SFTPWorkspacePaneComponent implements OnDestroy {
    @Input() startLocal = false
    @Input() initialProfile?: any
    @Input() initialSession?: SSHSession
    @Output() busyChange = new EventEmitter<boolean>()

    source: 'picker'|'local'|'remote' = 'picker'
    profiles: any[] = []
    profile?: any
    files: WorkspaceFile[] = []
    path = ''
    pathInput = ''
    filter = ''
    loading = false
    error = ''
    showPicker = true
    selectedGroup: string|null = null
    selectedFile?: WorkspaceFile
    private sshSession?: SSHSession
    private sftp?: SFTPSession
    private ownsSession = false
    private static activeDrag: { pane: SFTPWorkspacePaneComponent, file: WorkspaceFile }|null = null

    constructor (
        private injector: Injector,
        private profilesService: ProfilesService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        private ngbModal: NgbModal,
    ) { }

    async ngOnInit (): Promise<void> {
        this.profiles = (await this.profilesService.getProfiles()).filter((profile: any) => profile.type === 'ssh' && !profile.isTemplate && !profile.isBuiltin)
        if (this.initialSession) {
            await this.selectSession(this.initialSession, this.initialProfile ?? this.initialSession.profile)
        } else if (this.initialProfile) {
            await this.chooseProfile(this.initialProfile)
        } else if (this.startLocal) {
            await this.chooseLocal()
        }
    }

    async ngOnDestroy (): Promise<void> {
        if (this.ownsSession) {
            await this.sshSession?.destroy().catch(() => undefined)
        }
    }

    get title (): string {
        if (this.showPicker) { return 'Select Host' }
        if (this.source === 'local') { return 'Local' }
        if (this.source === 'remote') { return this.profile?.name ?? 'Remote' }
        return 'Select Host'
    }

    get filteredProfiles (): any[] {
        const query = this.filter.trim().toLowerCase()
        return this.profiles
            .filter(profile => !this.selectedGroup || (profile.group || 'ungrouped') === this.selectedGroup)
            .filter(profile => !query || `${profile.name} ${this.profileGroupName(profile)} ${profile.options?.host ?? ''} ${profile.options?.user ?? ''}`.toLowerCase().includes(query))
    }

    get pickerGroups (): { id: string, name: string, count: number }[] {
        const groups = new Map<string, { id: string, name: string, count: number }>()
        for (const profile of this.profiles) {
            const id = profile.group || 'ungrouped'
            if (id === 'ungrouped') { continue }
            const current = groups.get(id) ?? { id, name: this.profileGroupName(profile), count: 0 }
            current.count++
            groups.set(id, current)
        }
        return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
    }

    get filteredFiles (): WorkspaceFile[] {
        const query = this.filter.trim().toLowerCase()
        return this.files.filter(file => !query || file.name.toLowerCase().includes(query))
    }

    openPicker (): void {
        this.showPicker = true
        this.filter = ''
        this.selectedGroup = null
        this.selectedFile = undefined
    }

    selectGroup (id: string|null): void { this.selectedGroup = id; this.filter = '' }

    async chooseLocal (): Promise<void> {
        await this.releaseOwnedSession()
        this.source = 'local'
        this.profile = undefined
        this.sftp = undefined
        this.showPicker = false
        this.path = ''
        this.pathInput = ''
        this.selectedFile = undefined
        await this.navigate()
    }

    async chooseProfile (profile: any): Promise<void> {
        this.loading = true
        this.error = ''
        this.busyChange.emit(true)
        const next = new SSHSession(this.injector, this.profilesService.getConfigProxyForProfile(profile) as any)
        try {
            await next.start()
            await this.releaseOwnedSession()
            await this.useSession(next, profile, true)
        } catch (error) {
            await next.destroy().catch(() => undefined)
            this.error = error?.message ?? String(error)
            this.notifications.error(this.error, 'SFTP')
            this.showPicker = true
        } finally {
            this.loading = false
            this.busyChange.emit(false)
        }
    }

    async selectSession (session: SSHSession, profile: any): Promise<void> {
        this.loading = true
        this.error = ''
        this.busyChange.emit(true)
        try {
            await this.releaseOwnedSession()
            await this.useSession(session, profile, false)
        } catch (error) {
            this.error = error?.message ?? String(error)
            this.notifications.error(this.error, 'SFTP')
            this.showPicker = true
        } finally {
            this.loading = false
            this.busyChange.emit(false)
        }
    }

    private async useSession (session: SSHSession, profile: any, ownsSession: boolean): Promise<void> {
        this.sshSession = session
        this.ownsSession = ownsSession
        this.profile = profile
        this.sftp = await session.openSFTP()
        this.source = 'remote'
        this.showPicker = false
        this.path = '/'
        this.pathInput = '/'
        this.selectedFile = undefined
        await this.navigate('/')
    }

    private async releaseOwnedSession (): Promise<void> {
        if (this.ownsSession) {
            await this.sshSession?.destroy().catch(() => undefined)
        }
        this.sshSession = undefined
        this.ownsSession = false
    }

    async navigate (target?: string, preserveInputOnError = false): Promise<void> {
        this.loading = true
        this.error = ''
        this.selectedFile = undefined
        const previousPath = this.path
        try {
            if (this.source === 'local') {
                const result = await ipcRenderer.invoke('sftp-local:list', target ?? (this.path || undefined))
                this.path = result.path
                this.files = result.files.map(file => ({ ...file, modified: new Date(file.modified), mode: file.mode ?? 0o644 }))
            } else if (this.source === 'remote' && this.sftp) {
                const nextPath = target ?? (this.path || '/')
                const files = await this.sftp.readdir(nextPath)
                this.path = nextPath
                this.files = files
            }
            this.pathInput = this.path
            this.files.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
        } catch (error) {
            this.path = previousPath
            if (!preserveInputOnError) { this.pathInput = previousPath }
            this.error = error?.message ?? String(error)
            this.notifications.error(this.error, 'Could not open folder')
        } finally {
            this.loading = false
        }
    }

    /** Opens a pasted path in this pane without changing the other SFTP side. */
    async navigatePathInput (event?: KeyboardEvent): Promise<void> {
        event?.preventDefault()
        const input = this.pathInput.trim()
        if (!input) {
            this.pathInput = this.path
            return
        }

        let target: string
        if (this.source === 'local') {
            const localPath = window['nodeRequire']('path')
            const home = window['nodeRequire']('os').homedir()
            const expanded = input === '~'
                ? home
                : input.startsWith('~/') || input.startsWith('~\\')
                    ? localPath.join(home, input.slice(2))
                    : input
            target = localPath.isAbsolute(expanded)
                ? localPath.normalize(expanded)
                : localPath.resolve(this.path || home, expanded)
        } else {
            target = input.startsWith('/')
                ? posixPath.normalize(input)
                : posixPath.resolve(this.path || '/', input)
        }

        this.pathInput = target
        await this.navigate(target, true)
        ;(event?.target as HTMLInputElement|undefined)?.blur()
    }

    resetPathInput (event?: KeyboardEvent): void {
        event?.preventDefault()
        this.pathInput = this.path
        ;(event?.target as HTMLInputElement|undefined)?.blur()
    }

    selectPathInput (event: FocusEvent): void {
        ;(event.target as HTMLInputElement|null)?.select()
    }

    goUp (): void {
        if (this.source === 'local') {
            const localPath = window['nodeRequire']('path')
            this.navigate(localPath.dirname(this.path))
        } else {
            this.navigate(posixPath.dirname(this.path))
        }
    }

    async open (file: WorkspaceFile): Promise<void> {
        if (file.isDirectory) {
            await this.navigate(file.fullPath)
        } else if (this.source === 'local') {
            this.platform.openPath(file.fullPath)
        } else if (this.sftp) {
            const transfer = await this.platform.startDownload(file.name, file.mode, file.size)
            if (transfer) { await this.sftp.download(file.fullPath, transfer) }
        }
    }

    async uploadFiles (): Promise<void> {
        if (this.source !== 'remote' || !this.sftp) { return }
        const transfers = await this.platform.startUpload({ multiple: true })
        for (const transfer of transfers) {
            await this.sftp.upload(posixPath.join(this.path, transfer.getName()), transfer)
        }
        await this.navigate(this.path)
    }

    async createFolder (): Promise<void> {
        if (this.source === 'picker') { return }
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = 'New folder name'
        const result = await modal.result.catch(() => null)
        const name = result?.value?.trim()
        if (!name) { return }
        try {
            await this.createDirectory(name)
            await this.navigate(this.path)
        } catch (error) {
            this.notifications.error(error?.message ?? String(error), 'Could not create folder')
        }
    }

    async renameSelected (): Promise<void> {
        const file = this.selectedFile
        if (!file) { return }
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = `Rename “${file.name}”`
        modal.componentInstance.value = file.name
        const result = await modal.result.catch(() => null)
        const name = result?.value?.trim()
        if (!name || name === file.name || name.includes('/') || name.includes('\\')) { return }
        try {
            if (this.source === 'local') {
                await ipcRenderer.invoke('sftp-local:rename', file.fullPath, name)
            } else if (this.sftp) {
                const destination = posixPath.join(posixPath.dirname(file.fullPath), name)
                await this.sftp.stat(destination).then(() => { throw new Error(`“${name}” already exists`) }).catch(error => {
                    if (String(error?.message ?? error).includes('already exists')) { throw error }
                })
                await this.sftp.rename(file.fullPath, destination)
            }
            await this.navigate(this.path)
        } catch (error) {
            this.notifications.error(error?.message ?? String(error), 'Could not rename item')
        }
    }

    async deleteSelected (): Promise<void> {
        const file = this.selectedFile
        if (!file) { return }
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `Delete “${file.name}”?`,
            detail: file.isDirectory ? 'The folder and all of its contents will be permanently removed.' : 'The file will be permanently removed.',
            buttons: ['Delete', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        })
        if (result.response !== 0) { return }
        try {
            if (this.source === 'local') {
                await ipcRenderer.invoke('sftp-local:remove', file.fullPath)
            } else {
                await this.removeRemote(file)
            }
            await this.navigate(this.path)
        } catch (error) {
            this.notifications.error(error?.message ?? String(error), 'Could not delete item')
        }
    }

    startDrag (file: WorkspaceFile, event: DragEvent): void {
        SFTPWorkspacePaneComponent.activeDrag = { pane: this, file }
        event.dataTransfer?.setData('application/x-tabby-sftp-file', file.fullPath)
        if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'copy' }
    }

    allowDrop (event: DragEvent): void {
        if (SFTPWorkspacePaneComponent.activeDrag?.pane !== this) {
            event.preventDefault()
            if (event.dataTransfer) { event.dataTransfer.dropEffect = 'copy' }
        }
    }

    async acceptDrop (event: DragEvent): Promise<void> {
        const drag = SFTPWorkspacePaneComponent.activeDrag
        SFTPWorkspacePaneComponent.activeDrag = null
        if (!drag || drag.pane === this) { return }
        event.preventDefault()
        this.loading = true
        this.busyChange.emit(true)
        try {
            await this.importFrom(drag.pane, drag.file)
            await this.navigate(this.path)
            this.notifications.info(`${drag.file.name} copied`, 'SFTP')
        } catch (error) {
            this.notifications.error(error?.message ?? String(error), 'SFTP transfer failed')
        } finally {
            this.loading = false
            this.busyChange.emit(false)
        }
    }

    private async importFrom (source: SFTPWorkspacePaneComponent, file: WorkspaceFile): Promise<void> {
        if (file.isDirectory) {
            const destination = await this.createDirectory(file.name)
            const children = await source.listDirectory(file.fullPath)
            const previous = this.path
            this.path = destination
            try {
                for (const child of children) { await this.importFrom(source, child) }
            } finally {
                this.path = previous
            }
            return
        }
        const bytes = await source.readFile(file)
        await this.writeFile(file.name, bytes, file.mode)
    }

    private async listDirectory (target: string): Promise<WorkspaceFile[]> {
        if (this.source === 'local') {
            const result = await ipcRenderer.invoke('sftp-local:list', target)
            return result.files.map(file => ({ ...file, modified: new Date(file.modified), mode: file.mode ?? 0o644 }))
        }
        if (!this.sftp) { throw new Error('The remote SFTP session is not connected') }
        return this.sftp.readdir(target)
    }

    private async readFile (file: WorkspaceFile): Promise<Uint8Array> {
        if (this.source === 'local') {
            return new Uint8Array(await ipcRenderer.invoke('sftp-local:read-file', file.fullPath))
        }
        if (!this.sftp) { throw new Error('The remote SFTP session is not connected') }
        const handle = await this.sftp.open(file.fullPath, russh.OPEN_READ)
        const chunks: Uint8Array[] = []
        let length = 0
        try {
            while (true) {
                const chunk = await handle.read()
                if (!chunk.length) { break }
                chunks.push(chunk)
                length += chunk.length
            }
        } finally {
            await handle.close()
        }
        const result = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
        return result
    }

    private async writeFile (name: string, bytes: Uint8Array, mode: number): Promise<void> {
        if (this.source === 'local') {
            await ipcRenderer.invoke('sftp-local:write-file', this.path, name, bytes)
            return
        }
        if (!this.sftp) { throw new Error('The remote SFTP session is not connected') }
        let destination = posixPath.join(this.path, name)
        for (let suffix = 1; ; suffix++) {
            try {
                await this.sftp.stat(destination)
                const extension = posixPath.extname(name)
                const stem = posixPath.basename(name, extension)
                destination = posixPath.join(this.path, `${stem} copy${suffix === 1 ? '' : ` ${suffix}`}${extension}`)
            } catch {
                break
            }
        }
        await this.sftp.upload(destination, new MemoryFileUpload(posixPath.basename(destination), bytes, mode))
    }

    private async createDirectory (name: string): Promise<string> {
        if (this.source === 'local') {
            return ipcRenderer.invoke('sftp-local:mkdir', this.path, name)
        }
        if (!this.sftp) { throw new Error('The remote SFTP session is not connected') }
        let target = posixPath.join(this.path, name)
        for (let suffix = 1; ; suffix++) {
            try {
                await this.sftp.stat(target)
                target = posixPath.join(this.path, `${name} copy${suffix === 1 ? '' : ` ${suffix}`}`)
            } catch {
                // The first path that cannot be stat'ed is the only one we try
                // to create. Permission and transport errors from mkdir must
                // escape instead of turning into an endless copy-name loop.
                await this.sftp.mkdir(target)
                return target
            }
        }
    }

    formatSize (size: number): string {
        if (size < 1024) { return `${size} B` }
        if (size < 1024 * 1024) { return `${Math.round(size / 1024)} KB` }
        return `${(size / 1024 / 1024).toFixed(1)} MB`
    }

    formatPermissions (file: WorkspaceFile): string {
        const mode = file.mode ?? 0
        const execute = (bit: number, specialBit: number, active: string, inactive: string): string => {
            if (mode & specialBit) { return mode & bit ? active : inactive }
            return mode & bit ? 'x' : '-'
        }
        const type = file.isSymlink ? 'l' : file.isDirectory ? 'd' : '-'
        return `${type}${mode & 0o400 ? 'r' : '-'}${mode & 0o200 ? 'w' : '-'}${execute(0o100, 0o4000, 's', 'S')}` +
            `${mode & 0o040 ? 'r' : '-'}${mode & 0o020 ? 'w' : '-'}${execute(0o010, 0o2000, 's', 'S')}` +
            `${mode & 0o004 ? 'r' : '-'}${mode & 0o002 ? 'w' : '-'}${execute(0o001, 0o1000, 't', 'T')}`
    }

    describePermissions (file: WorkspaceFile): string {
        const mode = file.mode ?? 0
        const access = (read: number, write: number, execute: number): string => {
            const allowed = [
                mode & read ? 'read' : null,
                mode & write ? 'write' : null,
                mode & execute ? 'execute' : null,
            ].filter(Boolean)
            return allowed.length ? allowed.join(', ') : 'no access'
        }
        const octal = (mode & 0o7777).toString(8).padStart(4, '0')
        return `Mode ${octal} — Owner: ${access(0o400, 0o200, 0o100)}; Group: ${access(0o040, 0o020, 0o010)}; Others: ${access(0o004, 0o002, 0o001)}`
    }

    private profileGroupName (profile: any): string {
        return profile.group ? this.profilesService.resolveProfileGroupName(profile.group) : 'Ungrouped'
    }

    private async removeRemote (file: WorkspaceFile): Promise<void> {
        if (!this.sftp) { throw new Error('The remote SFTP session is not connected') }
        if (!file.isDirectory || file.isSymlink) {
            await this.sftp.unlink(file.fullPath)
            return
        }
        const children = await this.sftp.readdir(file.fullPath)
        for (const child of children) { await this.removeRemote(child) }
        await this.sftp.rmdir(file.fullPath)
    }
}
