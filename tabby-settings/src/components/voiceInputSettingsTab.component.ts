import { Component, HostBinding } from '@angular/core'
import { ConfigService, NotificationsService } from 'tabby-core'
import { ipcRenderer } from 'electron'

@Component({ selector: 'voice-input-settings-tab', templateUrl: './voiceInputSettingsTab.component.pug' })
export class VoiceInputSettingsTabComponent {
    statusText = 'Checking bundled runtime…'

    @HostBinding('class.content-box') true

    constructor (public config: ConfigService, private notifications: NotificationsService) { this.refresh() }

    async refresh (): Promise<void> {
        try {
            const state = await ipcRenderer.invoke('voice-transcription:status', this.voiceConfig)
            this.statusText = state.ready ? 'GigaAM v3 E2E CTC Q4 is ready for local transcription.' : `Runtime or model missing: ${state.modelPath}`
        } catch (error) {
            this.statusText = error?.message ?? String(error)
        }
    }

    async save (): Promise<void> {
        this.config.store.voiceInput.maxRecordingSeconds = Math.max(1, Math.min(25, Number(this.config.store.voiceInput.maxRecordingSeconds) || 25))
        await this.config.save()
        await this.refresh()
        this.notifications.info('Voice input settings saved')
    }

    /** ConfigService values are proxied and cannot cross Electron's structured-clone boundary. */
    private get voiceConfig (): any {
        const value = this.config.store.voiceInput ?? {}
        return {
            enabled: value.enabled !== false,
            runtimePath: String(value.runtimePath ?? ''),
            modelPath: String(value.modelPath ?? ''),
            maxRecordingSeconds: Math.max(1, Math.min(25, Number(value.maxRecordingSeconds) || 25)),
        }
    }
}
