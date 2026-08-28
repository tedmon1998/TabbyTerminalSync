import { Component, HostBinding, Input } from '@angular/core'

import { AppService } from '../services/app.service'
import { ConfigService } from '../services/config.service'
import { CommandHistoryService } from '../services/commandHistory.service'
import { NotificationsService } from '../services/notifications.service'
import { PlatformService } from '../api/platform'
import { ipcRenderer } from 'electron'

interface CommandTopic { id: string; name: string; description?: string }
interface CommandEntry { id: string; topicId: string; name: string; description?: string; command: string; favorite?: boolean }

/** A direct, Termius-inspired command/snippet shelf beside the active terminal. */
@Component({
    selector: 'command-sidebar',
    templateUrl: './commandSidebar.component.pug',
    styleUrls: ['./commandSidebar.component.scss'],
})
export class CommandSidebarComponent {
    query = ''
    expanded: Record<string, boolean> = {}
    editingCommand: CommandEntry|null = null
    creatingCommand = false
    editingTopic: CommandTopic|null = null
    creatingTopic = false
    @Input() bottomMode = false
    @HostBinding('class.bottom-mode') get isBottomMode (): boolean { return this.bottomMode }
    activePanel: 'snippets'|'assistant'|'history' = 'snippets'
    assistantQuestion = ''
    assistantBusy = false
    assistantResult: { command: string, explanation: string }|null = null
    assistantContextSummary = ''
    recording = false
    transcribingVoice = false
    voiceStatus = ''
    private recorder: MediaRecorder|null = null
    private recordingTimer: ReturnType<typeof setTimeout>|null = null

    constructor (
        public config: ConfigService,
        private app: AppService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        private commandHistory: CommandHistoryService,
    ) { }

    ngOnInit (): void { if (this.bottomMode) { this.activePanel = 'assistant' } }

    get topics (): CommandTopic[] { return this.library.commandTopics ?? [] }
    get commands (): CommandEntry[] { return this.library.commands ?? [] }

    get filteredTopics (): CommandTopic[] {
        const query = this.query.trim().toLowerCase()
        if (!query) { return this.topics }
        return this.topics.filter(topic => topic.name.toLowerCase().includes(query) || this.commandsFor(topic.id).some(command => this.matches(command, query)))
    }

    commandsFor (topicID: string): CommandEntry[] {
        const query = this.query.trim().toLowerCase()
        return this.commands
            .filter(command => command.topicId === topicID)
            .filter(command => !query || this.matches(command, query))
            .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name))
    }

    isExpanded (topic: CommandTopic): boolean { return this.expanded[topic.id] ?? false }
    toggleTopic (topic: CommandTopic): void { this.expanded[topic.id] = !this.isExpanded(topic) }

    newTopic (): void {
        this.creatingTopic = true
        this.editingTopic = { id: this.newID(), name: '', description: '' }
        this.closeCommandEditor()
    }

    async askAssistant (): Promise<void> {
        if (!this.assistantQuestion.trim()) { return }
        this.assistantBusy = true
        this.assistantResult = null
        try {
            const context = await this.collectAssistantContext()
            this.assistantContextSummary = this.describeAssistantContext(context)
            this.assistantResult = await ipcRenderer.invoke('llm-assistant:ask', {
                connection: this.llmConnection,
                question: this.assistantQuestion,
                context,
            })
        } catch (error) {
            this.notifications.error(error?.message ?? String(error), 'AI assistant')
        } finally {
            this.assistantBusy = false
        }
    }

    async insertAssistantCommand (): Promise<void> {
        if (!this.assistantResult?.command) { return }
        await navigator.clipboard.writeText(this.assistantResult.command)
        this.notifications.info('Suggested command copied')
    }

    runAssistantCommand (): void {
        if (!this.assistantResult?.command) { return }
        this.run({ id: '', topicId: '', name: 'AI suggestion', command: this.assistantResult.command })
    }

    async openBottomAssistant (): Promise<void> {
        this.library.aiChatOpen = true
        await this.config.save()
    }

    async closePanel (): Promise<void> {
        if (this.bottomMode) { this.library.aiChatOpen = false } else { this.library.commandSidebarOpen = false }
        await this.config.save()
    }

    get historyEntries (): any[] { return this.commandHistory.entries }

    async copyHistory (entry: any): Promise<void> {
        await navigator.clipboard.writeText(entry.command)
        this.notifications.info('Command copied')
    }

    runHistory (entry: any): void {
        this.run({ id: entry.id, topicId: '', name: 'History', command: entry.command })
    }

    async toggleVoiceRecording (): Promise<void> {
        if (this.recording) {
            this.recorder?.stop()
            return
        }
        if (!this.config.store.voiceInput?.enabled) {
            this.notifications.error('Enable Voice input in Settings first')
            return
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            const chunks: Blob[] = []
            const recorder = new MediaRecorder(stream)
            this.recorder = recorder
            this.recording = true
            this.voiceStatus = 'Recording… tap the microphone again to transcribe.'
            recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data) } }
            recorder.onerror = () => this.finishVoiceRecording(stream, null)
            recorder.onstop = () => this.finishVoiceRecording(stream, new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
            recorder.start()
            const seconds = Math.max(1, Math.min(25, Number(this.config.store.voiceInput.maxRecordingSeconds) || 25))
            this.recordingTimer = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), seconds * 1000)
        } catch (error) {
            this.voiceStatus = ''
            this.notifications.error(error?.message ?? 'Microphone access was not granted', 'Voice input')
        }
    }

    editTopic (topic: CommandTopic): void {
        this.creatingTopic = false
        this.editingTopic = { ...topic }
        this.closeCommandEditor()
    }

    async saveTopic (): Promise<void> {
        const topic = this.editingTopic
        if (!topic?.name.trim()) { return }
        const next = { ...topic, name: topic.name.trim() }
        this.library.commandTopics = this.topics.some(item => item.id === topic.id)
            ? this.topics.map(item => item.id === topic.id ? next : item)
            : [...this.topics, next]
        this.expanded[topic.id] = true
        this.closeTopicEditor()
        await this.config.save()
    }

    async deleteTopic (topic: CommandTopic): Promise<void> {
        const count = this.commands.filter(item => item.topicId === topic.id).length
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `Delete category “${topic.name}”?`,
            detail: count ? `${count} command(s) in this category will also be deleted.` : 'This category is empty.',
            buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
        })
        if (result.response !== 0) { return }
        this.library.commandTopics = this.topics.filter(item => item.id !== topic.id)
        this.library.commands = this.commands.filter(item => item.topicId !== topic.id)
        if (this.editingTopic?.id === topic.id) { this.closeTopicEditor() }
        await this.config.save()
    }

    newCommand (topicID?: string): void {
        const firstTopicID = topicID ?? this.topics[0]?.id
        if (!firstTopicID) {
            this.notifications.info('Create a category before adding a command')
            this.newTopic()
            return
        }
        this.creatingCommand = true
        this.editingCommand = { id: this.newID(), topicId: firstTopicID, name: '', description: '', command: '' }
        this.closeTopicEditor()
    }

    editCommand (command: CommandEntry): void {
        this.creatingCommand = false
        this.editingCommand = { ...command }
        this.closeTopicEditor()
    }

    async saveCommand (): Promise<void> {
        const command = this.editingCommand
        if (!command?.name.trim() || !command.command.trim() || !command.topicId) { return }
        const next = { ...command, name: command.name.trim(), command: command.command.trim() }
        this.library.commands = this.commands.some(item => item.id === command.id)
            ? this.commands.map(item => item.id === command.id ? next : item)
            : [...this.commands, next]
        this.expanded[command.topicId] = true
        this.closeCommandEditor()
        await this.config.save()
    }

    async deleteCommand (command: CommandEntry): Promise<void> {
        const result = await this.platform.showMessageBox({
            type: 'warning', message: `Delete command “${command.name}”?`,
            buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
        })
        if (result.response !== 0) { return }
        this.library.commands = this.commands.filter(item => item.id !== command.id)
        if (this.editingCommand?.id === command.id) { this.closeCommandEditor() }
        await this.config.save()
    }

    copy (command: CommandEntry): void {
        this.platform.setClipboard({ text: command.command })
        this.notifications.info('Command copied to clipboard')
    }

    run (command: CommandEntry): void {
        let candidate: any = this.app.activeTab
        while (candidate?.focusedTab) { candidate = candidate.focusedTab }
        if (!candidate?.session || typeof candidate.sendInput !== 'function') {
            this.notifications.error('Open and select a terminal session before running a command')
            return
        }
        candidate.sendInput(command.command.endsWith('\n') ? command.command : `${command.command}\n`)
        this.notifications.info('Command sent to the active terminal')
    }

    async toggleFavorite (command: CommandEntry): Promise<void> {
        this.library.commands = this.commands.map(item => item.id === command.id ? { ...item, favorite: !item.favorite } : item)
        await this.config.save()
    }

    closeCommandEditor (): void { this.editingCommand = null; this.creatingCommand = false }
    closeTopicEditor (): void { this.editingTopic = null; this.creatingTopic = false }

    get library (): any {
        this.config.store.postgresSync ??= { commandTopics: [], commands: [] }
        this.config.store.postgresSync.commandTopics ??= []
        this.config.store.postgresSync.commands ??= []
        return this.config.store.postgresSync
    }

    private async collectAssistantContext (): Promise<any> {
        let candidate: any = this.app.activeTab
        while (candidate?.focusedTab) { candidate = candidate.focusedTab }
        const base = { platform: process.platform, arch: process.arch, remote: false, directoryEntries: [] as string[] }
        if (candidate?.sshSession?.collectAssistantContext) {
            const remote = await candidate.sshSession.collectAssistantContext()
            return { ...base, ...remote, remote: true, shell: 'ssh' }
        }
        const cwd = await candidate?.session?.getWorkingDirectory?.().catch(() => null)
        if (this.config.store.llmAssistant?.includeDirectoryNames) {
            const local = await ipcRenderer.invoke('llm-assistant:local-context', cwd)
            return { ...base, ...local, shell: candidate?.profile?.options?.command ?? undefined }
        }
        return { ...base, cwd: cwd ?? undefined, shell: candidate?.profile?.options?.command ?? undefined }
    }

    private describeAssistantContext (context: any): string {
        const location = context.remote ? 'SSH' : 'local'
        const entries = context.directoryEntries?.length ? `, ${context.directoryEntries.length} names` : ''
        return `${location}: ${context.platform}${context.cwd ? ` · ${context.cwd}` : ''}${entries}`
    }

    private async finishVoiceRecording (stream: MediaStream, blob: Blob|null): Promise<void> {
        stream.getTracks().forEach(track => track.stop())
        if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null }
        this.recording = false
        this.recorder = null
        if (!blob) { return }
        this.transcribingVoice = true
        this.voiceStatus = 'Transcribing locally with GigaAM…'
        try {
            const wav = await this.toWav(blob)
            const text = await ipcRenderer.invoke('voice-transcription:transcribe', new Uint8Array(wav), this.voiceConfig)
            if (text) {
                this.assistantQuestion = [this.assistantQuestion.trim(), text].filter(Boolean).join(this.assistantQuestion.trim() ? ' ' : '')
                this.voiceStatus = 'Text added to the request. Review it before asking AI.'
            } else {
                this.voiceStatus = 'No speech was recognized.'
            }
        } catch (error) {
            this.voiceStatus = ''
            this.notifications.error(error?.message ?? String(error), 'Voice transcription failed')
        } finally {
            this.transcribingVoice = false
        }
    }

    private async toWav (blob: Blob): Promise<ArrayBuffer> {
        const data = await blob.arrayBuffer()
        const context = new AudioContext()
        try {
            const audio = await context.decodeAudioData(data.slice(0))
            const length = Math.ceil(audio.length * 16000 / audio.sampleRate)
            const mono = new Float32Array(length)
            for (let i = 0; i < length; i++) {
                const sourceIndex = Math.min(audio.length - 1, Math.floor(i * audio.sampleRate / 16000))
                let sample = 0
                for (let channel = 0; channel < audio.numberOfChannels; channel++) { sample += audio.getChannelData(channel)[sourceIndex] }
                mono[i] = sample / audio.numberOfChannels
            }
            const wav = new ArrayBuffer(44 + mono.length * 2)
            const view = new DataView(wav)
            const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
            text(0, 'RIFF'); view.setUint32(4, 36 + mono.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
            view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true)
            view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, mono.length * 2, true)
            mono.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true))
            return wav
        } finally {
            await context.close()
        }
    }

    private get llmConnection (): any {
        const value = this.config.store.llmAssistant ?? {}
        const provider = value.provider === 'openWebUI' ? 'openWebUI' : 'ollama'
        const settings = provider === 'openWebUI' ? (value.openWebUI ?? value) : (value.ollama ?? value)
        return {
            enabled: !!value.enabled,
            provider,
            baseUrl: String(settings.baseUrl ?? ''),
            model: String(settings.model ?? ''),
            apiKeySaved: !!settings.apiKeySaved,
        }
    }

    private get voiceConfig (): any {
        const value = this.config.store.voiceInput ?? {}
        return {
            enabled: value.enabled !== false,
            runtimePath: String(value.runtimePath ?? ''),
            modelPath: String(value.modelPath ?? ''),
            maxRecordingSeconds: Math.max(1, Math.min(25, Number(value.maxRecordingSeconds) || 25)),
        }
    }

    private matches (command: CommandEntry, query: string): boolean {
        return `${command.name} ${command.description ?? ''} ${command.command}`.toLowerCase().includes(query)
    }

    private newID (): string { return `${Date.now()}-${Math.random().toString(36).substring(2)}` }
}
