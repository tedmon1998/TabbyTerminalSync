import { ConfigProvider, Platform } from 'tabby-core'

/** @hidden */
export class SettingsConfigProvider extends ConfigProvider {
    defaults = {
        configSync: {
            host: null,
            token: null,
            configID: null,
            auto: false,
            parts: {
                hotkeys: true,
                appearance: true,
                vault: true,
            },
        },
        postgresSync: {
            enabled: false,
            autoSync: true,
            host: '',
            port: 5432,
            database: '',
            user: '',
            ssl: true,
            passwordSaved: false,
            deviceID: '',
            initialized: false,
            connectionFingerprint: '',
            lastAttemptAt: '',
            lastSuccessfulSyncAt: '',
            metadata: {},
            commandTopics: [],
            commands: [],
            commandSidebarOpen: true,
        },
        llmAssistant: {
            enabled: false,
            provider: 'ollama',
            baseUrl: '',
            model: '',
            ollama: {
                baseUrl: '',
                model: '',
            },
            openWebUI: {
                baseUrl: '',
                model: '',
                apiKeySaved: false,
            },
            includeDirectoryNames: true,
        },
        voiceInput: {
            enabled: true,
            runtimePath: '',
            modelPath: '',
            maxRecordingSeconds: 25,
        },
        commandHistory: {
            enabled: true,
            limit: 500,
            entries: [],
        },
        hotkeys: {
            'settings-tab': {
                __nonStructural: true,
            },
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                settings: ['⌘-,'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                settings: ['Ctrl-,'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                settings: ['Ctrl-,'],
            },
        },
    }
}
