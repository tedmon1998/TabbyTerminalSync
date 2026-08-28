import { Component, HostBinding, OnDestroy } from '@angular/core'
import { ConfigService, NotificationsService } from 'tabby-core'
import { PostgresSyncService } from '../services/postgresSync.service'

@Component({
    selector: 'postgres-sync-settings-tab',
    templateUrl: './postgresSyncSettingsTab.component.pug',
})
export class PostgresSyncSettingsTabComponent implements OnDestroy {
    password = ''
    passwordVisible = false
    busy = false

    private passwordLoadedFromKeychain = false
    private passwordHideTimer: ReturnType<typeof setTimeout>|null = null

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public sync: PostgresSyncService,
        private notifications: NotificationsService,
    ) { }

    ngOnDestroy (): void {
        this.clearPasswordHideTimer()
    }

    async togglePasswordVisibility (): Promise<void> {
        if (this.passwordVisible) {
            this.hidePassword()
            return
        }
        try {
            if (!this.password && this.config.store.postgresSync.passwordSaved) {
                this.password = await this.sync.getPassword()
                this.passwordLoadedFromKeychain = true
                if (!this.password) {
                    throw new Error('The saved password is not available in the system keychain.')
                }
            }
            this.passwordVisible = true
            this.schedulePasswordHide()
        } catch (error) {
            this.passwordVisible = false
            this.passwordLoadedFromKeychain = false
            this.notifications.error(error?.message ?? String(error), 'Could not show PostgreSQL password')
        }
    }

    onPasswordChanged (): void {
        this.passwordLoadedFromKeychain = false
        if (this.passwordVisible) {
            this.schedulePasswordHide()
        }
    }

    async test (): Promise<void> {
        this.busy = true
        try {
            if (this.password) {
                await this.sync.savePassword(this.password)
                this.clearPasswordField()
            }
            await this.config.save()
            await this.sync.test()
            this.notifications.info('PostgreSQL connection verified and sync schema initialized')
        } catch (error) {
            this.notifications.error(error?.message ?? String(error), 'PostgreSQL connection failed')
        } finally {
            this.busy = false
        }
    }

    async synchronize (): Promise<void> {
        this.busy = true
        try {
            if (this.password) {
                await this.sync.savePassword(this.password)
                this.clearPasswordField()
            }
            this.config.store.postgresSync.enabled = true
            await this.config.save()
            const synchronized = await this.sync.sync(true)
            if (synchronized) {
                this.notifications.info('Profiles and command library synchronized')
            } else {
                this.notifications.error(this.sync.lastError || 'Synchronization is already running.', 'Synchronization deferred')
            }
        } catch (error) {
            this.notifications.error(error?.message ?? String(error), 'PostgreSQL synchronization failed')
        } finally {
            this.busy = false
        }
    }

    async autoSyncChanged (): Promise<void> {
        try {
            await this.config.save()
            if (this.config.store.postgresSync.enabled && this.config.store.postgresSync.autoSync) {
                await this.sync.sync(false)
            }
        } catch (error) {
            this.notifications.error(error?.message ?? String(error), 'Could not update automatic synchronization')
        }
    }

    async forgetPassword (): Promise<void> {
        await this.sync.clearPassword()
        this.clearPasswordField()
        this.notifications.info('Saved PostgreSQL password removed')
    }

    private schedulePasswordHide (): void {
        this.clearPasswordHideTimer()
        this.passwordHideTimer = setTimeout(() => this.hidePassword(), 20000)
    }

    private hidePassword (): void {
        this.passwordVisible = false
        this.clearPasswordHideTimer()
        if (this.passwordLoadedFromKeychain) {
            this.password = ''
            this.passwordLoadedFromKeychain = false
        }
    }

    private clearPasswordField (): void {
        this.clearPasswordHideTimer()
        this.password = ''
        this.passwordVisible = false
        this.passwordLoadedFromKeychain = false
    }

    private clearPasswordHideTimer (): void {
        if (this.passwordHideTimer) {
            clearTimeout(this.passwordHideTimer)
            this.passwordHideTimer = null
        }
    }
}
