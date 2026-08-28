import { AfterViewInit, Component, ElementRef, HostListener, Injector, Input, OnDestroy, ViewChild } from '@angular/core'
import { BaseTabComponent } from 'tabby-core'
import { SSHSession } from '../session/ssh'
import { SFTPWorkspacePaneComponent } from './sftpWorkspacePane.component'

/** A standalone, Termius-style SFTP workspace: choose a saved host on the right. */
@Component({
    selector: 'sftp-workspace-tab',
    templateUrl: './sftpWorkspaceTab.component.pug',
    styleUrls: ['./sftpWorkspaceTab.component.scss'],
})
export class SFTPWorkspaceTabComponent extends BaseTabComponent implements AfterViewInit, OnDestroy {
    @Input() initialProfile?: any
    @Input() initialSession?: SSHSession
    @ViewChild('rightPane') rightPane?: SFTPWorkspacePaneComponent

    leftWidth = Number(localStorage.getItem('tabby-sync-sftp-left-width') ?? 50)
    resizing = false

    constructor (injector: Injector, private element: ElementRef<HTMLElement>) {
        super(injector)
        this.setTitle('SFTP')
        this.icon = 'far fa-folder-open'
    }

    ngAfterViewInit (): void {
        this.leftWidth = Math.max(25, Math.min(75, Number.isFinite(this.leftWidth) ? this.leftWidth : 50))
    }

    get gridColumns (): string {
        return `${this.leftWidth}% 5px minmax(0, 1fr)`
    }

    startResize (event: MouseEvent): void {
        event.preventDefault()
        this.resizing = true
        document.body.classList.add('sftp-resizing')
    }

    nudgeResize (delta: number, event: KeyboardEvent): void {
        event.preventDefault()
        this.leftWidth = Math.max(25, Math.min(75, this.leftWidth + delta))
        localStorage.setItem('tabby-sync-sftp-left-width', String(this.leftWidth))
    }

    @HostListener('document:mousemove', ['$event'])
    resize (event: MouseEvent): void {
        if (!this.resizing) { return }
        const bounds = this.element.nativeElement.getBoundingClientRect()
        const percentage = ((event.clientX - bounds.left) / bounds.width) * 100
        this.leftWidth = Math.max(25, Math.min(75, percentage))
    }

    @HostListener('document:mouseup')
    stopResize (): void {
        if (!this.resizing) { return }
        this.resizing = false
        document.body.classList.remove('sftp-resizing')
        localStorage.setItem('tabby-sync-sftp-left-width', String(this.leftWidth))
    }

    ngOnDestroy (): void {
        document.body.classList.remove('sftp-resizing')
    }

    async openProfile (profile: any, session?: SSHSession): Promise<void> {
        this.initialProfile = profile
        this.initialSession = session
        if (this.rightPane) {
            if (session) {
                await this.rightPane.selectSession(session, profile)
            } else {
                await this.rightPane.chooseProfile(profile)
            }
        }
    }
}
