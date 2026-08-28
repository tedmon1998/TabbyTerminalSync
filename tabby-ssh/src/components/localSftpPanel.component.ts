import { Component } from '@angular/core'
import { ipcRenderer } from 'electron'

interface LocalSFTPFile { name: string, fullPath: string, isDirectory: boolean, isSymlink: boolean, size: number, modified: number }

/** Local half of the dual-pane SFTP browser. File contents never leave the machine until a user starts an upload. */
@Component({
    selector: 'local-sftp-panel',
    templateUrl: './localSftpPanel.component.pug',
    styleUrls: ['./localSftpPanel.component.scss'],
})
export class LocalSFTPPanelComponent {
    path = ''
    files: LocalSFTPFile[] = []
    error = ''
    loading = true
    filter = ''

    async ngOnInit (): Promise<void> { await this.navigate() }

    async navigate (target?: string): Promise<void> {
        this.loading = true
        this.error = ''
        try {
            const result = await ipcRenderer.invoke('sftp-local:list', target ?? (this.path || undefined))
            this.path = result.path
            this.files = result.files.sort((a: LocalSFTPFile, b: LocalSFTPFile) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
        } catch (error) {
            this.error = error?.message ?? String(error)
        } finally {
            this.loading = false
        }
    }

    open (file: LocalSFTPFile): void {
        if (file.isDirectory) { this.navigate(file.fullPath) }
    }

    get filteredFiles (): LocalSFTPFile[] {
        const query = this.filter.trim().toLowerCase()
        return this.files.filter(file => !query || file.name.toLowerCase().includes(query))
    }

    formatSize (size: number): string {
        if (size < 1024) { return `${size} B` }
        if (size < 1024 * 1024) { return `${Math.round(size / 1024)} KB` }
        return `${(size / 1024 / 1024).toFixed(1)} MB`
    }

    formatDate (value: number): string {
        return new Date(value).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' })
    }
}
