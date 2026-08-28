import { Component, HostBinding, OnInit } from '@angular/core'
import { ConfigService, NotificationsService } from 'tabby-core'
import { ipcRenderer } from 'electron'

interface LLMModel {
    name: string
    model: string
    parameterSize?: string
    quantizationLevel?: string
}

interface ProviderSettings {
    baseUrl: string
    model: string
    apiKeySaved?: boolean
}

@Component({
    selector: 'llm-assistant-settings-tab',
    templateUrl: './llmAssistantSettingsTab.component.pug',
})
export class LLMAssistantSettingsTabComponent implements OnInit {
    availableModels: LLMModel[] = []
    apiKey = ''
    busy = false
    connectionVerified = false
    connectionError = ''

    @HostBinding('class.content-box') true

    constructor (public config: ConfigService, private notifications: NotificationsService) { }

    ngOnInit (): void {
        this.ensureProviderSettings(true)
        if (this.providerSettings.baseUrl.trim()) {
            void this.refreshApiKeyStatus()
            void this.testAndLoadModels(false)
        }
    }

    onProviderChanged (): void {
        this.ensureProviderSettings()
        this.resetConnectionState()
        this.apiKey = ''
        void this.config.save()
        if (this.providerSettings.baseUrl.trim()) {
            void this.refreshApiKeyStatus()
            void this.testAndLoadModels(false)
        }
    }

    onServerChanged (): void {
        this.resetConnectionState()
        if (this.provider === 'openWebUI') {
            this.providerSettings.apiKeySaved = false
        }
    }

    async refreshApiKeyStatus (): Promise<void> {
        if (this.provider !== 'openWebUI' || !this.providerSettings.baseUrl.trim()) { return }
        try {
            this.providerSettings.apiKeySaved = await ipcRenderer.invoke('llm-assistant:has-api-key', this.connection)
        } catch {
            this.providerSettings.apiKeySaved = false
        }
    }

    async testAndLoadModels (showNotification = true): Promise<void> {
        if (this.busy) { return }
        this.busy = true
        this.connectionVerified = false
        this.connectionError = ''
        try {
            if (this.provider === 'openWebUI' && this.apiKey.trim()) {
                await ipcRenderer.invoke('llm-assistant:save-api-key', this.connection, this.apiKey.trim())
                this.providerSettings.apiKeySaved = true
                this.apiKey = ''
            }
            const result = await ipcRenderer.invoke('llm-assistant:test', this.connection)
            this.availableModels = Array.isArray(result?.models) ? result.models : []
            this.providerSettings.baseUrl = String(result?.baseUrl ?? this.providerSettings.baseUrl)
            this.providerSettings.apiKeySaved = !!result?.apiKeySaved
            const selected = String(this.providerSettings.model ?? '')
            if (!this.availableModels.some(model => model.model === selected)) {
                this.providerSettings.model = this.availableModels[0]?.model ?? ''
            }
            await this.config.save()
            this.connectionVerified = true
            if (showNotification) {
                const suffix = this.availableModels.length === 1 ? 'model found' : 'models found'
                this.notifications.info(`${this.providerName} connected: ${this.availableModels.length} ${suffix}`)
            }
        } catch (error) {
            this.availableModels = []
            this.connectionError = error?.message ?? String(error)
            if (showNotification) {
                this.notifications.error(this.connectionError, `${this.providerName} connection failed`)
            }
        } finally {
            this.busy = false
        }
    }

    async forgetApiKey (): Promise<void> {
        await ipcRenderer.invoke('llm-assistant:clear-api-key', this.connection)
        this.providerSettings.apiKeySaved = false
        this.apiKey = ''
        this.resetConnectionState()
        await this.config.save()
        this.notifications.info('Open WebUI API key removed from the system keychain')
    }

    async saveModel (): Promise<void> {
        await this.config.save()
    }

    modelDetails (model: LLMModel): string {
        return [model.parameterSize, model.quantizationLevel].filter(Boolean).join(' · ')
    }

    get provider (): 'ollama'|'openWebUI' {
        return this.config.store.llmAssistant?.provider === 'openWebUI' ? 'openWebUI' : 'ollama'
    }

    get providerName (): string { return this.provider === 'openWebUI' ? 'Open WebUI' : 'Ollama' }

    get providerSettings (): ProviderSettings {
        const value = this.ensureProviderSettings()
        return this.provider === 'openWebUI' ? value.openWebUI : value.ollama
    }

    get connection (): any {
        const settings = this.providerSettings
        return {
            enabled: !!this.config.store.llmAssistant.enabled,
            provider: this.provider,
            baseUrl: String(settings.baseUrl ?? ''),
            model: String(settings.model ?? ''),
            apiKeySaved: !!settings.apiKeySaved,
        }
    }

    private ensureProviderSettings (migrateLegacy = false): any {
        const value = this.config.store.llmAssistant ??= {}
        value.provider = value.provider === 'openWebUI' ? 'openWebUI' : 'ollama'
        value.ollama ??= { baseUrl: '', model: '' }
        value.openWebUI ??= { baseUrl: '', model: '', apiKeySaved: false }
        if (migrateLegacy && value.baseUrl && !value.ollama.baseUrl) {
            value.ollama.baseUrl = String(value.baseUrl)
            value.ollama.model = String(value.model ?? '')
        }
        return value
    }

    private resetConnectionState (): void {
        this.availableModels = []
        this.connectionVerified = false
        this.connectionError = ''
    }
}
