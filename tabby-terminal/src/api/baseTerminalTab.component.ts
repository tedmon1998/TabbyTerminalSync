import { Observable, Subject, first, auditTime, debounce, interval } from 'rxjs'
import { Spinner } from 'cli-spinner'
import colors from 'ansi-colors'
import { ipcRenderer } from 'electron'
import { NgZone, OnInit, OnDestroy, Injector, ViewChild, HostBinding, Input, ElementRef, InjectFlags, Component } from '@angular/core'
import { trigger, transition, style, animate, AnimationTriggerMetadata } from '@angular/animations'
import { AppService, ConfigService, BaseTabComponent, HostAppService, HotkeysService, NotificationsService, Platform, LogService, Logger, TabContextMenuItemProvider, SplitTabComponent, SubscriptionContainer, MenuItemOptions, PlatformService, HostWindowService, ResettableTimeout, TranslateService, ThemesService, FullyDefined, VaultService, CommandHistoryService } from 'tabby-core'

import { BaseSession } from '../session'

import { Frontend } from '../frontends/frontend'
import { XTermFrontend, XTermWebGLFrontend } from '../frontends/xtermFrontend'
import { ResizeEvent, BaseTerminalProfile } from './interfaces'
import { TerminalDecorator } from './decorator'
import { SearchPanelComponent } from '../components/searchPanel.component'
import { MultifocusService } from '../services/multifocus.service'
import { getTerminalBackgroundColor } from '../helpers'


const INACTIVE_TAB_UNLOAD_DELAY = 1000 * 30
const OSC_FOCUS_IN = Buffer.from('\x1b[I')
const OSC_FOCUS_OUT = Buffer.from('\x1b[O')

interface TerminalPathSuggestion {
    name: string
    value: string
    fullPath: string
}

/**
 * A class to base your custom terminal tabs on
 */
@Component({ template: '' })
export class BaseTerminalTabComponent<P extends BaseTerminalProfile> extends BaseTabComponent implements OnInit, OnDestroy {
    static template: string = require('../components/baseTerminalTab.component.pug')
    static styles: string[] = [require('../components/baseTerminalTab.component.scss')]
    static animations: AnimationTriggerMetadata[] = [
        trigger('toolbarSlide', [
            transition(':enter', [
                style({
                    transform: 'translateY(-25%)',
                    opacity: '0',
                }),
                animate('100ms ease-out', style({
                    transform: 'translateY(0%)',
                    opacity: '1',
                })),
            ]),
            transition(':leave', [
                animate('100ms ease-out', style({
                    transform: 'translateY(-25%)',
                    opacity: '0',
                })),
            ]),
        ]),
        trigger('panelSlide', [
            transition(':enter', [
                style({
                    transform: 'translateY(25%)',
                    opacity: '0',
                }),
                animate('100ms ease-out', style({
                    transform: 'translateY(0%)',
                    opacity: '1',
                })),
            ]),
            transition(':leave', [
                animate('100ms ease-out', style({
                    transform: 'translateY(25%)',
                    opacity: '0',
                })),
            ]),
        ]),
    ]

    session: BaseSession|null = null
    savedState?: any
    savedStateIsLive = false

    @Input() zoom = 0

    @Input() showSearchPanel = false

    /** @hidden */
    @ViewChild('content') content

    /** @hidden */
    @HostBinding('style.background-color') backgroundColor: string|null = null

    /** @hidden */
    @HostBinding('class.toolbar-enabled') enableToolbar = false

    /** @hidden */
    @HostBinding('class.toolbar-pinned') pinToolbar = false

    /** @hidden */
    @HostBinding('class.toolbar-revealed') revealToolbar = false

    frontend?: Frontend

    /** @hidden */
    frontendIsReady = false

    frontendReady = new Subject<void>()
    size: ResizeEvent

    profile: FullyDefined<P>

    /**
     * Enables normal passthrough from session output to terminal input
     */
    enablePassthrough = true

    /**
     * Disables display of dynamic window/tab title provided by the shell
     */
    disableDynamicTitle = false

    alternateScreenActive = false
    private commandHistoryBuffer = ''
    private lastAIRequest = ''
    private lastAIGeneratedCommand = ''
    private aiRegenerationAttempt = 0
    aiRewriteBusy = false
    pathSuggestions: TerminalPathSuggestion[] = []
    pathSuggestionIndex = 0
    pathSuggestionsLoading = false
    recordingVoice = false
    transcribingVoice = false
    private voiceRecorder: MediaRecorder|null = null
    private voiceStream: MediaStream|null = null
    private voiceRecordingTimer: ReturnType<typeof setTimeout>|null = null
    private pendingCommandCapture: Buffer[] = []
    private commandCaptureFrame: number|null = null
    private scrollOnInputFrame: number|null = null
    private pathSuggestionTimer: ReturnType<typeof setTimeout>|null = null
    private pathSuggestionRequest = 0
    private recentTerminalOutput = ''

    /** The AI action appears only after the user has typed a command request. */
    get aiRewriteAvailable (): boolean {
        return !this.alternateScreenActive && !!this.commandHistoryBuffer.trim()
    }

    get aiRegenerateAvailable (): boolean {
        return !!this.lastAIGeneratedCommand && this.commandHistoryBuffer.trim() === this.lastAIGeneratedCommand
    }

    get pathSuggestionsVisible (): boolean {
        return !this.alternateScreenActive && (this.pathSuggestionsLoading || this.pathSuggestions.length > 0)
    }

    get voiceInputAvailable (): boolean {
        return !this.alternateScreenActive && this.config.store.voiceInput?.enabled !== false
    }

    @HostBinding('class.command-tools-visible') get commandToolsVisible (): boolean {
        return this.aiRewriteAvailable || this.aiRewriteBusy || this.voiceInputAvailable
    }

    @ViewChild(SearchPanelComponent, { 'static': false }) searchPanel?: SearchPanelComponent

    // Deps start
    config: ConfigService
    element: ElementRef
    protected zone: NgZone
    protected app: AppService
    protected hostApp: HostAppService
    protected hotkeys: HotkeysService
    protected platform: PlatformService
    protected notifications: NotificationsService
    protected log: LogService
    protected decorators: TerminalDecorator[] = []
    protected contextMenuProviders: TabContextMenuItemProvider[]
    protected hostWindow: HostWindowService
    protected translate: TranslateService
    protected multifocus: MultifocusService
    protected themes: ThemesService
    protected vault: VaultService
    protected commandHistory: CommandHistoryService
    // Deps end

    protected logger: Logger
    protected output = new Subject<string>()
    protected binaryOutput = new Subject<Buffer>()
    protected sessionChanged = new Subject<BaseSession|null>()
    protected recentInputs = ''
    private bellPlayer: HTMLAudioElement
    private termContainerSubscriptions = new SubscriptionContainer()
    private sessionHandlers = new SubscriptionContainer()
    private spinner = new Spinner({
        stream: {
            write: x => {
                try {
                    if (!this.frontend) {
                        return
                    }
                    this.writeRaw(x)
                } catch {
                    this.spinner.stop()
                }
            },
        },
    })

    private spinnerActive = false
    private spinnerPaused = false
    private toolbarRevealTimeout = new ResettableTimeout(() => {
        this.revealToolbar = false
    }, 1000)

    private frontendWriteLock = Promise.resolve()

    get input$ (): Observable<Buffer> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }
        return this.frontend.input$
    }

    get output$ (): Observable<string> { return this.output }
    get binaryOutput$ (): Observable<Buffer> { return this.binaryOutput }

    get resize$ (): Observable<ResizeEvent> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }
        return this.frontend.resize$
    }

    get alternateScreenActive$ (): Observable<boolean> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }
        return this.frontend.alternateScreenActive$
    }

    get frontendReady$ (): Observable<void> { return this.frontendReady }

    get sessionChanged$ (): Observable<BaseSession|null> { return this.sessionChanged }

    constructor (protected injector: Injector) {
        super(injector)

        this.config = injector.get(ConfigService)
        this.element = injector.get(ElementRef)
        this.zone = injector.get(NgZone)
        this.app = injector.get(AppService)
        this.hostApp = injector.get(HostAppService)
        this.hotkeys = injector.get(HotkeysService)
        this.platform = injector.get(PlatformService)
        this.notifications = injector.get(NotificationsService)
        this.log = injector.get(LogService)
        this.decorators = injector.get<any>(TerminalDecorator, null, InjectFlags.Optional) as TerminalDecorator[]
        this.contextMenuProviders = injector.get<any>(TabContextMenuItemProvider, null, InjectFlags.Optional) as TabContextMenuItemProvider[]
        this.hostWindow = injector.get(HostWindowService)
        this.translate = injector.get(TranslateService)
        this.multifocus = injector.get(MultifocusService)
        this.themes = injector.get(ThemesService)
        this.vault = injector.get(VaultService)
        this.commandHistory = injector.get(CommandHistoryService)

        this.logger = this.log.create('baseTerminalTab')
        this.setTitle(this.translate.instant('Terminal'))

        this.subscribeUntilDestroyed(this.hotkeys.unfilteredHotkey$, async hotkey => {
            if (!this.hasFocus) {
                return
            }
            if (hotkey === 'search') {
                this.showSearchPanel = true
                setImmediate(() => {
                    const input = this.element.nativeElement.querySelector('.search-input')
                    const selectedText = (this.frontend?.getSelection() ?? '').trim()
                    if (input && selectedText.length) {
                        input.value = selectedText
                    }

                    input?.focus()
                    input?.select()
                })
            }
        })

        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, async hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'ctrl-c':
                    if (this.frontend?.getSelection()) {
                        this.frontend.copySelection()
                        this.frontend.clearSelection()
                        this.notifications.notice(this.translate.instant('Copied'))
                    } else {
                        this.forEachFocusedTerminalPane(tab => tab.sendInput('\x03'))
                    }
                    break
                case 'copy':
                    this.frontend?.copySelection()
                    this.frontend?.clearSelection()
                    this.notifications.notice(this.translate.instant('Copied'))
                    break
                case 'paste':
                    this.forEachFocusedTerminalPane(tab => tab.paste())
                    break
                case 'select-all':
                    this.frontend?.selectAll()
                    break
                case 'clear':
                    this.forEachFocusedTerminalPane(tab => tab.frontend?.clear())
                    break
                case 'zoom-in':
                    this.forEachFocusedTerminalPane(tab => tab.zoomIn())
                    break
                case 'zoom-out':
                    this.forEachFocusedTerminalPane(tab => tab.zoomOut())
                    break
                case 'reset-zoom':
                    this.forEachFocusedTerminalPane(tab => tab.resetZoom())
                    break
                case 'previous-word':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput({
                            [Platform.Windows]: '\x1b[1;5D',
                            [Platform.macOS]: '\x1bb',
                            [Platform.Linux]: '\x1bb',
                        }[this.hostApp.platform])
                    })
                    break
                case 'next-word':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput({
                            [Platform.Windows]: '\x1b[1;5C',
                            [Platform.macOS]: '\x1bf',
                            [Platform.Linux]: '\x1bf',
                        }[this.hostApp.platform])
                    })
                    break
                case 'delete-line':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput('\x1bw')
                    })
                    break
                case 'delete-previous-word':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput('\u0017')
                    })
                    break
                case 'delete-next-word':
                    this.forEachFocusedTerminalPane(tab => {
                        tab.sendInput({
                            [Platform.Windows]: '\x1bd\x1b[3;5~',
                            [Platform.macOS]: '\x1bd',
                            [Platform.Linux]: '\x1bd',
                        }[this.hostApp.platform])
                    })
                    break
                case 'copy-current-path':
                    this.copyCurrentPath()
                    break
                case 'scroll-to-top':
                    this.frontend?.scrollToTop()
                    break
                case 'scroll-page-up':
                    this.frontend?.scrollPages(-1)
                    break
                case 'scroll-up':
                    this.frontend?.scrollLines(-1)
                    break
                case 'scroll-down':
                    this.frontend?.scrollLines(1)
                    break
                case 'scroll-page-down':
                    this.frontend?.scrollPages(1)
                    break
                case 'scroll-to-bottom':
                    this.frontend?.scrollToBottom()
                    break
            }
        })

        this.bellPlayer = document.createElement('audio')
        this.bellPlayer.src = require('../bell.ogg')
        this.bellPlayer.load()

        this.contextMenuProviders.sort((a, b) => a.weight - b.weight)
    }

    /** @hidden */
    ngOnInit (): void {
        this.pinToolbar = this.enableToolbar && (window.localStorage.pinTerminalToolbar ?? 'true') === 'true'

        this.focused$.subscribe(() => {
            this.configure()
            this.frontend?.focus()
        })

        this.subscribeUntilDestroyed(this.platform.themeChanged$, () => {
            this.configure()
        })

        // Check if the the WebGL renderer is compatible with xterm.js:
        // - https://github.com/Eugeny/tabby/issues/8884
        // - https://github.com/microsoft/vscode/issues/190195
        // - https://github.com/xtermjs/xterm.js/issues/4665
        // - https://bugs.chromium.org/p/chromium/issues/detail?id=1476475
        //
        // Inspired by https://github.com/microsoft/vscode/pull/191795

        let enable8884Workarround = false
        const checkCanvas = document.createElement('canvas')
        const checkGl = checkCanvas.getContext('webgl2')
        const debugInfo = checkGl?.getExtension('WEBGL_debug_renderer_info')
        if (checkGl && debugInfo) {
            const renderer = checkGl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
            if (renderer.startsWith('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)')) {
                enable8884Workarround = true
            }
        }

        const cls: new (..._) => Frontend = enable8884Workarround ? XTermFrontend : {
            xterm: XTermFrontend,
            'xterm-webgl': XTermWebGLFrontend,
        }[this.config.store.terminal.frontend] ?? XTermFrontend
        this.frontend = new cls(this.injector)

        this.frontendReady$.pipe(first()).subscribe(() => {
            // xterm is opened outside Angular's zone so ordinary typing stays
            // off the global change-detection path. Re-enter only for the
            // one-time renderer-ready state that affects the template.
            this.zone.run(() => this.onFrontendReady())
        })

        this.frontend.resize$.pipe(first()).subscribe(async ({ columns, rows }) => {
            this.size = { columns, rows }
            this.frontendReady.next()
            this.frontendReady.complete()

            this.config.enabledServices(this.decorators).forEach(decorator => {
                try {
                    decorator.attach(this)
                } catch (e) {
                    this.logger.warn('Decorator attach() throws', e)
                }
            })

            setTimeout(() => {
                this.session?.resize(columns, rows)
            }, 1000)

            this.session?.releaseInitialDataBuffer()
            this.sessionChanged$.subscribe(() => {
                this.session?.releaseInitialDataBuffer()
            })
        })

        this.alternateScreenActive$.subscribe(active => {
            if (active !== this.alternateScreenActive) {
                this.zone.run(() => {
                    this.alternateScreenActive = active
                })
            }
        })

        setImmediate(async () => {
            if (this.hasFocus) {
                await this.frontend?.attach(this.content.nativeElement, this.profile)
                this.frontend?.configure(this.profile)
            } else {
                this.focused$.pipe(first()).subscribe(async () => {
                    await this.frontend?.attach(this.content.nativeElement, this.profile)
                    this.frontend?.configure(this.profile)
                })
            }
        })

        this.attachTermContainerHandlers()

        this.configure()

        setTimeout(() => {
            this.binaryOutput$.subscribe(() => {
                this.displayActivity()
            })
        }, 1000)

        this.frontend.bell$.subscribe(() => {
            if (this.config.store.terminal.bell === 'visual') {
                this.frontend?.visualBell()
            }
            if (this.config.store.terminal.bell === 'audible') {
                this.bellPlayer.play()
            }
        })

        this.frontend.focus()

        this.blurred$.subscribe(() => {
            this.multifocus.cancel()
        })

        this.visibility$
            .pipe(debounce(visibility => interval(visibility ? 0 : INACTIVE_TAB_UNLOAD_DELAY)))
            .subscribe(visibility => {
                if (visibility && this.frontend instanceof XTermFrontend) {
                    this.frontend.reactivate()
                }
            })
    }

    protected onFrontendReady (): void {
        this.frontendIsReady = true
        if (this.savedState) {
            this.frontend!.restoreState(this.savedState)
            if (!this.savedStateIsLive) {
                this.frontend!.write('\r\n\r\n')
                this.frontend!.write(colors.bgWhite.black(' * ') + colors.bgBlackBright.white(' History restored '))
                this.frontend!.write('\r\n\r\n')
            }
        }

        this.input$.subscribe(data => {
            this.recentInputs += data
            this.recentInputs = this.recentInputs.substring(this.recentInputs.length - 32)
        })
    }

    async buildContextMenu (): Promise<MenuItemOptions[]> {
        let items: MenuItemOptions[] = []
        for (const section of await Promise.all(this.contextMenuProviders.map(x => x.getItems(this)))) {
            items = items.concat(section)
            items.push({ type: 'separator' })
        }
        items.splice(items.length - 1, 1)
        return items
    }

    /**
     * Feeds input into the active session
     */
    sendInput (data: string|Buffer): void {
        if (!(data instanceof Buffer)) {
            data = Buffer.from(data, 'utf-8')
        }
        // Input delivery is the latency-critical path. Never wait for command
        // history, AI-button state or viewport work before feeding the session.
        this.session?.feedFromTerminal(data)
        this.scheduleCommandCapture(data)
        if (this.config.store.terminal.scrollOnInput && !data.equals(OSC_FOCUS_IN) && !data.equals(OSC_FOCUS_OUT)) {
            this.scheduleScrollOnInput()
        }
    }

    /**
     * Replaces the text currently typed at the shell prompt with an LLM
     * suggestion. The generated command is intentionally not executed: Enter
     * remains the user's explicit confirmation, matching Termius AI input.
     */
    async rewriteCurrentCommandWithAI (regenerate = false): Promise<void> {
        this.flushCommandCapture()
        const canRegenerate = regenerate && this.aiRegenerateAvailable
        const question = canRegenerate ? this.lastAIRequest : this.commandHistoryBuffer.trim()
        if (!question || this.aiRewriteBusy) { return }
        if (!canRegenerate) {
            this.aiRegenerationAttempt = 0
        } else {
            this.aiRegenerationAttempt++
        }
        this.aiRewriteBusy = true
        try {
            const context = await this.collectAICommandContext()
            const value = this.config.store.llmAssistant ?? {}
            const provider = value.provider === 'openWebUI' ? 'openWebUI' : 'ollama'
            const settings = provider === 'openWebUI' ? (value.openWebUI ?? value) : (value.ollama ?? value)
            const result = await ipcRenderer.invoke('llm-assistant:ask', {
                connection: {
                    enabled: !!value.enabled,
                    provider,
                    baseUrl: String(settings.baseUrl ?? ''),
                    model: String(settings.model ?? ''),
                    apiKeySaved: !!settings.apiKeySaved,
                },
                question,
                context,
                regeneration: canRegenerate ? {
                    previousCommand: this.lastAIGeneratedCommand,
                    attempt: this.aiRegenerationAttempt,
                } : undefined,
            })
            const command = String(result?.command ?? '').trim()
            if (!command) {
                throw new Error(result?.explanation || 'The AI service returned no command.')
            }
            // Ctrl+U clears the pending shell line without submitting it.
            this.sendInput('\x15')
            this.sendInput(command)
            this.flushCommandCapture()
            this.lastAIRequest = question
            this.lastAIGeneratedCommand = command
            this.frontend?.focus()
            this.notifications.info(canRegenerate ? 'AI generated another command. Press Enter to run it.' : 'AI replaced the current line. Press Enter to run it.')
        } catch (error) {
            this.notifications.error(this.describeAIError(error), 'AI command')
        } finally {
            this.aiRewriteBusy = false
        }
    }

    private describeAIError (error: any): string {
        const message = String(error?.cause?.message ?? error?.message ?? error ?? 'Unknown AI error')
        return message
            .replace(/^Error invoking remote method '[^']+':\s*/i, '')
            .replace(/^Error:\s*/i, '')
    }

    async toggleVoiceCommand (): Promise<void> {
        if (this.recordingVoice) {
            this.voiceRecorder?.stop()
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
            this.voiceStream = stream
            this.voiceRecorder = recorder
            this.recordingVoice = true
            recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data) } }
            recorder.onerror = () => void this.finishVoiceCommand(null)
            recorder.onstop = () => void this.finishVoiceCommand(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
            recorder.start()
            const seconds = Math.max(1, Math.min(25, Number(this.config.store.voiceInput.maxRecordingSeconds) || 25))
            this.voiceRecordingTimer = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), seconds * 1000)
        } catch (error) {
            this.notifications.error(error?.message ?? 'Microphone access was not granted', 'Voice input')
        }
    }

    private async collectAICommandContext (): Promise<any> {
        const terminal: any = this
        const base = { platform: process.platform, arch: process.arch, remote: false, directoryEntries: [] as string[] }
        if (terminal.sshSession?.collectAssistantContext) {
            try {
                const remote = await terminal.sshSession.collectAssistantContext()
                return { ...base, ...remote, remote: true, shell: 'ssh' }
            } catch (error) {
                // Some SSH servers allow an interactive shell but reject a
                // second exec channel (russh reports this only as SendError).
                // Directory context is optional, so never block the user's AI
                // request when that hidden probe is unavailable.
                this.logger.warn('Could not collect optional SSH assistant context', error)
                return { ...base, platform: 'remote', remote: true, shell: 'ssh' }
            }
        }
        const cwd = await this.session?.getWorkingDirectory?.().catch(() => null)
        if (this.config.store.llmAssistant?.includeDirectoryNames) {
            const local = await ipcRenderer.invoke('llm-assistant:local-context', cwd)
            return { ...base, ...local, shell: this.profile?.options?.command ?? undefined }
        }
        return { ...base, cwd: cwd ?? undefined, shell: this.profile?.options?.command ?? undefined }
    }

    private async finishVoiceCommand (blob: Blob|null): Promise<void> {
        this.voiceStream?.getTracks().forEach(track => track.stop())
        this.voiceStream = null
        if (this.voiceRecordingTimer) { clearTimeout(this.voiceRecordingTimer); this.voiceRecordingTimer = null }
        this.recordingVoice = false
        this.voiceRecorder = null
        if (!blob) { return }
        this.transcribingVoice = true
        try {
            const wav = await this.voiceBlobToWav(blob)
            const value = this.config.store.voiceInput ?? {}
            const text = await ipcRenderer.invoke('voice-transcription:transcribe', new Uint8Array(wav), {
                enabled: value.enabled !== false,
                runtimePath: String(value.runtimePath ?? ''),
                modelPath: String(value.modelPath ?? ''),
                maxRecordingSeconds: Math.max(1, Math.min(25, Number(value.maxRecordingSeconds) || 25)),
            })
            const normalizedText = this.normalizeVoiceText(text)
            if (normalizedText) {
                // A single UTF-8 write is important for ConPTY on Windows and
                // prevents readline from treating multibyte characters as a
                // sequence of synthetic key presses on POSIX shells.
                this.sendInput(Buffer.from(normalizedText, 'utf8'))
                this.frontend?.focus()
                this.notifications.info('Voice text inserted. Use AI to convert it or press Enter.')
            } else {
                this.notifications.info('No speech was recognized')
            }
        } catch (error) {
            this.notifications.error(error?.message ?? String(error), 'Voice transcription failed')
        } finally {
            this.transcribingVoice = false
        }
    }

    private normalizeVoiceText (text: unknown): string {
        return String(text ?? '')
            .normalize('NFC')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
            .replace(/\r\n?/g, '\n')
            .replace(/\s*\n+\s*/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .trim()
    }

    private async voiceBlobToWav (blob: Blob): Promise<ArrayBuffer> {
        const data = await blob.arrayBuffer()
        const context = new AudioContext()
        try {
            const audio = await context.decodeAudioData(data.slice(0))
            const length = Math.ceil(audio.length * 16000 / audio.sampleRate)
            const mono = new Float32Array(length)
            for (let i = 0; i < length; i++) {
                const sourceIndex = Math.min(audio.length - 1, Math.floor(i * audio.sampleRate / 16000))
                let sample = 0
                for (let channel = 0; channel < audio.numberOfChannels; channel++) {
                    sample += audio.getChannelData(channel)[sourceIndex]
                }
                mono[i] = sample / audio.numberOfChannels
            }
            const wav = new ArrayBuffer(44 + mono.length * 2)
            const view = new DataView(wav)
            const writeText = (offset: number, text: string) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
            writeText(0, 'RIFF'); view.setUint32(4, 36 + mono.length * 2, true); writeText(8, 'WAVE'); writeText(12, 'fmt ')
            view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true)
            view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeText(36, 'data'); view.setUint32(40, mono.length * 2, true)
            mono.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true))
            return wav
        } finally {
            await context.close()
        }
    }

    /** Stores completed, command-like lines only; never raw terminal output. */
    private scheduleCommandCapture (data: Buffer): void {
        this.pendingCommandCapture.push(Buffer.from(data))
        if (this.commandCaptureFrame !== null) { return }
        this.zone.runOutsideAngular(() => {
            this.commandCaptureFrame = requestAnimationFrame(() => this.flushCommandCapture())
        })
    }

    private flushCommandCapture (): void {
        if (this.commandCaptureFrame !== null) {
            cancelAnimationFrame(this.commandCaptureFrame)
            this.commandCaptureFrame = null
        }
        if (!this.pendingCommandCapture.length) { return }
        const data = Buffer.concat(this.pendingCommandCapture)
        this.pendingCommandCapture = []
        const wasActionVisible = this.aiRewriteAvailable
        const wasRegenerateVisible = this.aiRegenerateAvailable
        this.captureCommandHistory(data)
        this.schedulePathSuggestions()
        // The command text itself is intentionally not Angular state. Repaint
        // only when the compact AI action must enter or leave the DOM.
        if (wasActionVisible !== this.aiRewriteAvailable || wasRegenerateVisible !== this.aiRegenerateAvailable) {
            this.zone.run(() => undefined)
        }
    }

    private schedulePathSuggestions (): void {
        if (this.pathSuggestionTimer) {
            clearTimeout(this.pathSuggestionTimer)
            this.pathSuggestionTimer = null
        }
        const typedPath = this.parseCDPath()
        if (typedPath === null || this.alternateScreenActive) {
            this.clearPathSuggestions()
            return
        }
        const request = ++this.pathSuggestionRequest
        this.pathSuggestionTimer = setTimeout(() => {
            this.pathSuggestionTimer = null
            void this.loadPathSuggestions(typedPath, request)
        }, 90)
    }

    private parseCDPath (): string|null {
        const match = this.commandHistoryBuffer.match(/^\s*cd\s+(.*)$/s)
        if (!match) { return null }
        let value = match[1]
        if (/[;&|`$<>\r\n]/.test(value)) { return null }
        const quote = value[0]
        if (quote === '"' || quote === "'") {
            value = value.slice(1)
            if (value.endsWith(quote)) { value = value.slice(0, -1) }
        }
        return value.replace(/\\([\\ '"()\[\]{}])/g, '$1')
    }

    private async loadPathSuggestions (typedPath: string, request: number): Promise<void> {
        this.zone.run(() => { this.pathSuggestionsLoading = true })
        try {
            const cwd = await this.session?.getWorkingDirectory?.().catch(() => null)
            const terminal: any = this
            const remoteValues = terminal.listTerminalPathSuggestions
                ? await terminal.listTerminalPathSuggestions(cwd, typedPath)
                : null
            const values = Array.isArray(remoteValues)
                ? remoteValues
                : await ipcRenderer.invoke('terminal-path:list', { cwd, typedPath })
            if (request !== this.pathSuggestionRequest || typedPath !== this.parseCDPath()) { return }
            this.zone.run(() => {
                this.pathSuggestions = Array.isArray(values) ? values.slice(0, 16) : []
                this.pathSuggestionIndex = Math.min(this.pathSuggestionIndex, Math.max(0, this.pathSuggestions.length - 1))
            })
        } catch (error) {
            if (request === this.pathSuggestionRequest) {
                this.logger.debug('Could not list terminal path suggestions', error)
                this.zone.run(() => { this.pathSuggestions = [] })
            }
        } finally {
            if (request === this.pathSuggestionRequest) {
                this.zone.run(() => { this.pathSuggestionsLoading = false })
            }
        }
    }

    private clearPathSuggestions (): void {
        this.pathSuggestionRequest++
        if (!this.pathSuggestions.length && !this.pathSuggestionsLoading) { return }
        this.zone.run(() => {
            this.pathSuggestions = []
            this.pathSuggestionsLoading = false
            this.pathSuggestionIndex = 0
        })
    }

    private handlePathSuggestionInput (data: string|Buffer): boolean {
        if (!this.pathSuggestionsVisible) { return false }
        const input = data instanceof Buffer ? data.toString('utf8') : data
        if (input === '\x1b[B' || input === '\x1bOB') {
            if (this.pathSuggestions.length) {
                this.zone.run(() => { this.pathSuggestionIndex = (this.pathSuggestionIndex + 1) % this.pathSuggestions.length })
            }
            return true
        }
        if (input === '\x1b[A' || input === '\x1bOA') {
            if (this.pathSuggestions.length) {
                this.zone.run(() => { this.pathSuggestionIndex = (this.pathSuggestionIndex - 1 + this.pathSuggestions.length) % this.pathSuggestions.length })
            }
            return true
        }
        if (input === '\t' && this.pathSuggestions.length) {
            this.acceptPathSuggestion(this.pathSuggestions[this.pathSuggestionIndex])
            return true
        }
        if (input === '\x1b') {
            this.clearPathSuggestions()
            return true
        }
        return false
    }

    acceptPathSuggestion (suggestion: TerminalPathSuggestion): void {
        const escapedPath = this.escapeCDPath(suggestion.value)
        this.sendInput('\x15')
        this.sendInput(`cd ${escapedPath}`)
        this.flushCommandCapture()
        this.frontend?.focus()
    }

    selectPathSuggestion (index: number): void {
        this.pathSuggestionIndex = index
    }

    private escapeCDPath (value: string): string {
        if (process.platform === 'win32') {
            const shell = String(this.profile?.options?.command ?? '').toLowerCase()
            if (!/[\s&()\[\]{}^=;!'+,`~]/.test(value)) { return value }
            return shell.includes('powershell') || shell.includes('pwsh')
                ? `'${value.replace(/'/g, "''")}'`
                : `"${value.replace(/"/g, '\\"')}"`
        }
        return value.replace(/([^A-Za-z0-9_@%+=:,./~\-])/g, '\\$1')
    }

    private scheduleScrollOnInput (): void {
        if (this.scrollOnInputFrame !== null) { return }
        this.zone.runOutsideAngular(() => {
            this.scrollOnInputFrame = requestAnimationFrame(() => {
                this.scrollOnInputFrame = null
                this.frontend?.scrollToBottom()
            })
        })
    }

    private captureCommandHistory (data: Buffer): void {
        const history = (this.config.store as any).commandHistory
        if (this.alternateScreenActive) { return }
        const raw = data.toString('utf8')
        if (raw.includes('\x03') || raw.includes('\x15')) {
            this.commandHistoryBuffer = ''
        }
        if (raw.includes('\x17')) {
            this.commandHistoryBuffer = this.commandHistoryBuffer.trimEnd().replace(/\S+$/, '')
        }
        // Cursor/navigation and bracketed-paste markers are terminal protocol,
        // not part of the command that is sent to history or to the AI service.
        const text = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        for (const character of text) {
            if (character === '\b' || character === '\x7f') {
                this.commandHistoryBuffer = this.commandHistoryBuffer.slice(0, -1)
            } else if (character === '\r' || character === '\n') {
                const command = this.commandHistoryBuffer.trim()
                this.commandHistoryBuffer = ''
                this.lastAIRequest = ''
                this.lastAIGeneratedCommand = ''
                this.aiRegenerationAttempt = 0
                if (history?.enabled) { this.storeHistoryCommand(command) }
            } else if (character >= ' ' && character !== '\x7f') {
                this.commandHistoryBuffer += character
                this.commandHistoryBuffer = this.commandHistoryBuffer.slice(-4096)
            }
        }
    }

    private storeHistoryCommand (command: string): void {
        if (!command || !this.isSafeHistoryCommand(command)) { return }
        // The main process writes this to a device-local file.  It never waits
        // on PostgreSQL or the encrypted config, so terminal input stays fast.
        this.commandHistory.add(command, this.profile?.name ?? this.title ?? 'Terminal').catch(error => {
            this.logger.warn('Could not store local command history', error)
        })
    }

    private isSafeHistoryCommand (command: string): boolean {
        const lower = command.toLowerCase()
        if (this.isSecretInputPrompt()) { return false }
        if (/\b(password|passphrase|token|secret|api[_-]?key|private[_-]?key)\b\s*[=:]/.test(lower) || /sshpass|authorization:\s*bearer/.test(lower)) {
            return false
        }
        return !/[\x00-\x08\x0e-\x1f]/.test(command)
    }

    private isSecretInputPrompt (): boolean {
        const output = this.recentTerminalOutput
            .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
            .replace(/[\x00-\x08\x0b-\x1f]/g, '')
            .slice(-600)
        return /(?:password|passphrase|one[- ]time password|verification code|auth(?:entication)? code|otp|pin)(?:\s+for\s+[^\r\n:]+)?\s*[:?]\s*$/i.test(output)
    }

    private rememberTerminalOutput (data: string): void {
        this.recentTerminalOutput = (this.recentTerminalOutput + data).slice(-1200)
    }

    /**
     * Feeds input into the terminal frontend
     */
    async write (data: string): Promise<void> {
        this.frontendWriteLock = this.frontendWriteLock.then(() =>
            this.withSpinnerPaused(() => this.writeRaw(data)))
        await this.frontendWriteLock
    }

    protected async writeRaw (data: string): Promise<void> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }

        if (this.config.store.terminal.detectProgress) {
            const percentageMatch = /(^|[^\d])(\d+(\.\d+)?)%([^\d]|$)/.exec(data)
            if (!this.alternateScreenActive && percentageMatch) {
                const percentage = percentageMatch[3] ? parseFloat(percentageMatch[2]) : parseInt(percentageMatch[2])
                if (percentage > 0 && percentage <= 100) {
                    this.setProgress(percentage)
                }
            } else {
                this.setProgress(null)
            }
        }

        await this.frontend.write(data)
    }

    async paste (): Promise<void> {
        let data = this.platform.readClipboard()
        if (this.hostApp.platform === Platform.Windows) {
            data = data.replaceAll('\r\n', '\r')
        } else {
            data = data.replaceAll('\n', '\r')
        }

        if (this.config.store.terminal.replaceNewlinesWithSpacesOnPaste) {
            data = data.replace(/[\r\n]+/g, ' ')
        }

        if (this.config.store.terminal.trimWhitespaceOnPaste && data.indexOf('\n') === data.length - 1) {
            // Ends with a newline and has no other line breaks
            data = data.substring(0, data.length - 1)
        }

        if (!this.alternateScreenActive) {
            if ((data.includes('\r') || data.includes('\n')) && this.config.store.terminal.warnOnMultilinePaste) {
                const buttons = [
                    this.translate.instant('Paste'),
                    this.translate.instant('Cancel'),
                ]
                const result = (await this.platform.showMessageBox(
                    {
                        type: 'warning',
                        detail: data.slice(0, 1000),
                        message: this.translate.instant('Paste multiple lines?'),
                        buttons,
                        defaultId: 0,
                        cancelId: 1,
                    },
                )).response
                if (result === 1) {
                    return
                }
            } else {
                if (this.config.store.terminal.trimWhitespaceOnPaste) {
                    data = data.trimEnd()
                    if (!data.includes('\r')) {
                        data = data.trimStart()
                    }
                }
            }
        }

        if (this.config.store.terminal.bracketedPaste && this.frontend?.supportsBracketedPaste()) {
            data = `\x1b[200~${data}\x1b[201~`
        }
        this.sendInput(data)
    }

    /**
     * Applies the user settings to the terminal
     */
    configure (): void {
        this.frontend?.configure(this.profile)

        this.backgroundColor = getTerminalBackgroundColor(this.config, this.themes, this.profile.terminalColorScheme)
    }

    zoomIn (): void {
        this.zoom++
        this.frontend?.setZoom(this.zoom)
    }

    zoomOut (): void {
        this.zoom--
        this.frontend?.setZoom(this.zoom)
    }

    resetZoom (): void {
        this.zoom = 0
        this.frontend?.setZoom(this.zoom)
    }

    async copyCurrentPath (): Promise<void> {
        let cwd: string|null = null
        if (this.session?.supportsWorkingDirectory()) {
            cwd = await this.session.getWorkingDirectory()
        }
        if (cwd) {
            this.platform.setClipboard({ text: cwd })
            this.notifications.notice(this.translate.instant('Copied'))
        } else {
            this.notifications.error(this.translate.instant('Shell does not support current path detection'))
        }
    }

    /** @hidden */
    ngOnDestroy (): void {
        this.flushCommandCapture()
        if (this.pathSuggestionTimer) { clearTimeout(this.pathSuggestionTimer) }
        this.pathSuggestionRequest++
        if (this.scrollOnInputFrame !== null) {
            cancelAnimationFrame(this.scrollOnInputFrame)
            this.scrollOnInputFrame = null
        }
        if (this.voiceRecorder?.state !== 'inactive') { this.voiceRecorder?.stop() }
        this.voiceStream?.getTracks().forEach(track => track.stop())
        if (this.voiceRecordingTimer) { clearTimeout(this.voiceRecordingTimer) }
        super.ngOnDestroy()
        this.stopSpinner()
    }

    async destroy (): Promise<void> {
        this.frontend?.detach(this.content.nativeElement)
        this.frontend?.destroy()
        this.frontend = undefined
        this.content.nativeElement.remove()
        this.detachTermContainerHandlers()
        this.config.enabledServices(this.decorators).forEach(decorator => {
            try {
                decorator.detach(this)
            } catch (e) {
                this.logger.warn('Decorator attach() throws', e)
            }
        })
        this.output.complete()
        this.binaryOutput.complete()
        this.frontendReady.complete()

        super.destroy()
        if (this.session?.open) {
            await this.session.destroy()
        }
    }

    protected detachTermContainerHandlers (): void {
        this.termContainerSubscriptions.cancelAll()
    }

    private rightMouseDownTime = 0

    protected async handleRightMouseDown (event: MouseEvent): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        this.rightMouseDownTime = Date.now()
        if (this.config.store.terminal.rightClick === 'menu') {
            this.platform.popupContextMenu(await this.buildContextMenu(), event)
        }
    }

    protected async handleRightMouseUp (event: MouseEvent): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        if (this.config.store.terminal.rightClick === 'paste'
            || this.config.store.terminal.rightClick === 'clipboard') {
            const duration = Date.now() - this.rightMouseDownTime
            if (duration < 250) {
                if (this.config.store.terminal.rightClick === 'paste') {
                    this.paste()
                } else if (this.config.store.terminal.rightClick === 'clipboard') {
                    if (this.frontend?.getSelection()) {
                        this.frontend.copySelection()
                        this.frontend.clearSelection()
                    } else {
                        this.paste()
                    }
                }
            } else {
                this.platform.popupContextMenu(await this.buildContextMenu(), event)
            }
        }
    }

    protected attachTermContainerHandlers (): void {
        this.detachTermContainerHandlers()

        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }

        const maybeConfigure = () => {
            if (this.hasFocus) {
                setTimeout(() => this.configure(), 250)
            }
        }

        this.termContainerSubscriptions.subscribe(this.frontend.title$, title => this.zone.run(() => {
            if (!this.disableDynamicTitle) {
                this.setTitle(title)
            }
        }))

        this.termContainerSubscriptions.subscribe(this.focused$, () => this.frontend && (this.frontend.enableResizing = true))
        this.termContainerSubscriptions.subscribe(this.blurred$, () => this.frontend && (this.frontend.enableResizing = false))

        this.termContainerSubscriptions.subscribe(this.frontend.mouseEvent$, event => {
            if (event.type === 'mousedown') {
                if (event.which === 1) {
                    this.multifocus.cancel()
                }
                if (event.which === 2) {
                    if (this.config.store.terminal.pasteOnMiddleClick) {
                        this.paste()
                    }
                    event.preventDefault()
                    event.stopPropagation()
                    return
                }
                if (event.which === 3 || event.which === 1 && event.ctrlKey) {
                    this.handleRightMouseDown(event)
                    return
                }
            }
            if (event.type === 'mouseup') {
                if (event.which === 3 || event.which === 1 && event.ctrlKey) {
                    this.handleRightMouseUp(event)
                    return
                }
            }
            if (event.type === 'mousewheel') {
                let wheelDeltaY = 0

                if ('wheelDeltaY' in event) {
                    wheelDeltaY = (event as unknown as WheelEvent)['wheelDeltaY']
                } else {
                    wheelDeltaY = (event as unknown as WheelEvent).deltaY
                }

                if (event.altKey) {
                    event.preventDefault()
                    const delta = Math.round(wheelDeltaY / 50)
                    this.sendInput((delta > 0 ? '\u001bOA' : '\u001bOB').repeat(Math.abs(delta)))
                }
            }
        })

        this.termContainerSubscriptions.subscribe(this.frontend.input$, data => {
            if (!this.handlePathSuggestionInput(data)) {
                this.sendInput(data)
            }
        })

        this.termContainerSubscriptions.subscribe(this.frontend.resize$.pipe(auditTime(100)), ({ columns, rows }) => {
            this.logger.debug(`Resizing to ${columns}x${rows}`)
            this.size = { columns, rows }
            this.zone.run(() => {
                if (this.session?.open) {
                    this.session.resize(columns, rows)
                }
            })
        })

        this.termContainerSubscriptions.subscribe(this.platform.displayMetricsChanged$, maybeConfigure)
        this.termContainerSubscriptions.subscribe(this.hostWindow.windowMoved$, maybeConfigure)
    }

    setSession (session: BaseSession|null, destroyOnSessionClose = false): void {
        if (session) {
            if (this.session) {
                this.setSession(null)
            }
            this.detachSessionHandlers()
            this.session = session
            this.attachSessionHandlers(destroyOnSessionClose)
        } else {
            this.detachSessionHandlers()
            this.session = null
        }
        this.sessionChanged.next(session)
    }

    showToolbar (): void {
        this.revealToolbar = true
        this.toolbarRevealTimeout.clear()
    }

    hideToolbar (): void {
        this.toolbarRevealTimeout.set()
    }

    togglePinToolbar (): void {
        this.pinToolbar = !this.pinToolbar
        window.localStorage.pinTerminalToolbar = this.pinToolbar
    }

    @HostBinding('class.with-title-inset') get hasTitleInset (): boolean {
        return this.hostApp.platform === Platform.macOS && this.config.store.appearance.tabsLocation !== 'top' && this.config.store.appearance.frame === 'thin'
    }

    protected attachSessionHandler <T> (observable: Observable<T>, handler: (v: T) => void): void {
        this.sessionHandlers.subscribe(observable, handler)
    }

    protected attachSessionHandlers (destroyOnSessionClose = false): void {
        if (!this.session) {
            throw new Error('Session not set')
        }

        // this.session.output$.bufferTime(10).subscribe((datas) => {
        this.attachSessionHandler(this.session.output$, data => {
            if (this.enablePassthrough) {
                this.rememberTerminalOutput(data)
                this.output.next(data)
                this.write(data)
            }
        })

        this.attachSessionHandler(this.session.binaryOutput$, data => {
            if (this.enablePassthrough) {
                this.binaryOutput.next(data)
            }
        })

        this.attachSessionHandler(this.session.closed$, () => {
            this.onSessionClosed(destroyOnSessionClose)
        })

        this.attachSessionHandler(this.session.destroyed$, () => {
            this.onSessionDestroyed()
        })

        this.attachSessionHandler(this.session.oscProcessor.copyRequested$, content => {
            this.platform.setClipboard({ text: content })
            this.notifications.notice(this.translate.instant('Copied'))
        })
    }

    /**
     * Method called when session is closed.
     */
    protected onSessionClosed (destroyOnSessionClose = false): void {
        // Pinning only guards against manual close (see AppService.closeTab);
        // a shell exiting closes the tab normally per behaviorOnSessionEnd.
        if (destroyOnSessionClose || this.shouldTabBeDestroyedOnSessionClose()) {
            this.destroy()
        }
    }

    /**
     * Return true if tab should be destroyed on session closed.
     */
    protected shouldTabBeDestroyedOnSessionClose (): boolean {
        const behavior = this.profile.behaviorOnSessionEnd
        return behavior === 'close' || behavior === 'auto' && this.isSessionExplicitlyTerminated()
    }

    /**
     * Method called when session is destroyed. Set the session to null
     */
    protected onSessionDestroyed (): void {
        this.setSession(null)
    }

    protected detachSessionHandlers (): void {
        this.sessionHandlers.cancelAll()
    }

    protected startSpinner (text?: string): void {
        if (this.spinnerActive || this.spinnerPaused) {
            return
        }
        if (text) {
            this.spinner.text = text
        }
        this.spinner.setSpinnerString(6)
        this.spinnerActive = true
        this.zone.runOutsideAngular(() => {
            this.spinner.start()
        })
    }

    protected stopSpinner (): void {
        if (!this.spinnerActive) {
            return
        }
        this.spinner.stop(true)
        this.spinnerActive = false
    }

    protected async withSpinnerPaused (work: () => any): Promise<void> {
        this.spinnerPaused = true
        if (this.spinnerActive) {
            this.spinner.stop(true)
        }
        try {
            await work()
        } finally {
            this.spinnerPaused = false
            if (this.spinnerActive) {
                this.zone.runOutsideAngular(() => {
                    this.spinner.start()
                })
            }
        }
    }

    protected forEachFocusedTerminalPane (cb: (tab: BaseTerminalTabComponent<any>) => void): void {
        if (this.parent && this.parent instanceof SplitTabComponent && this.parent._allFocusMode) {
            for (const tab of this.parent.getAllTabs()) {
                if (tab instanceof BaseTerminalTabComponent) {
                    cb(tab)
                }
            }
        } else {
            cb(this)
        }
    }

    /**
     * Return true if the user explicitly exit the session
     */
    protected isSessionExplicitlyTerminated (): boolean {
        return false
    }
}
