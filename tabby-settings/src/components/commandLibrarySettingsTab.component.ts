import { Component, HostBinding } from '@angular/core'
import { ConfigService, NotificationsService, PlatformService } from 'tabby-core'
import { CommandEntry, CommandTopic, PostgresSyncService } from '../services/postgresSync.service'

@Component({
    selector: 'command-library-settings-tab',
    templateUrl: './commandLibrarySettingsTab.component.pug',
})
export class CommandLibrarySettingsTabComponent {
    selectedTopicID: string|null = null
    newTopicName = ''
    editing: CommandEntry|null = null

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        private sync: PostgresSyncService,
        private platform: PlatformService,
        private notifications: NotificationsService,
    ) { }

    get topics (): CommandTopic[] { return this.config.store.postgresSync.commandTopics }
    get commands (): CommandEntry[] { return this.config.store.postgresSync.commands }
    get selectedTopic (): CommandTopic|null { return this.topics.find(x => x.id === this.selectedTopicID) ?? null }
    get visibleCommands (): CommandEntry[] { return this.commands.filter(x => x.topicId === this.selectedTopicID) }
    get editingExistingCommand (): boolean { return !!this.editing && this.commands.some(x => x.id === this.editing!.id) }

    async addTopic (): Promise<void> {
        const name = this.newTopicName.trim()
        if (!name) { return }
        const topic = { id: this.newID(), name }
        this.config.store.postgresSync.commandTopics = [...this.topics, topic]
        this.selectedTopicID = topic.id
        this.newTopicName = ''
        await this.config.save()
    }

    async saveTopic (): Promise<void> {
        await this.config.save()
    }

    async deleteTopic (): Promise<void> {
        if (!this.selectedTopicID) { return }
        const id = this.selectedTopicID
        this.config.store.postgresSync.commandTopics = this.topics.filter(x => x.id !== id)
        this.config.store.postgresSync.commands = this.commands.filter(x => x.topicId !== id)
        this.selectedTopicID = null
        this.editing = null
        await this.config.save()
    }

    newCommand (): void {
        if (!this.selectedTopicID) { return }
        this.editing = { id: this.newID(), topicId: this.selectedTopicID, name: '', description: '', command: '' }
    }

    edit(command: CommandEntry): void {
        this.editing = { ...command }
    }

    async saveCommand (): Promise<void> {
        if (!this.editing || !this.editing.name.trim() || !this.editing.command.trim()) { return }
        const index = this.commands.findIndex(x => x.id === this.editing!.id)
        const next = [...this.commands]
        if (index >= 0) { next[index] = { ...this.editing } } else { next.push({ ...this.editing }) }
        this.config.store.postgresSync.commands = next
        this.editing = null
        await this.config.save()
    }

    async deleteCommand (command: CommandEntry): Promise<void> {
        this.config.store.postgresSync.commands = this.commands.filter(x => x.id !== command.id)
        if (this.editing?.id === command.id) { this.editing = null }
        await this.config.save()
    }

    copy(command: CommandEntry): void {
        this.platform.setClipboard({ text: command.command })
        this.notifications.info('Command copied to clipboard')
    }

    run(command: CommandEntry): void {
        if (this.sync.executeInActiveTerminal(command.command)) {
            this.notifications.info('Command sent to the active terminal')
        } else {
            this.notifications.error('Open and select a terminal session before running a command')
        }
    }

    private newID (): string {
        return `${Date.now()}-${Math.random().toString(36).substring(2)}`
    }
}
