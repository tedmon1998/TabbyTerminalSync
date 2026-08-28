import { app, ipcMain, Menu, Tray, shell, screen, globalShortcut, MenuItemConstructorOptions, WebContents } from 'electron'
import promiseIpc from 'electron-promise-ipc'
import * as remote from '@electron/remote/main'
import { spawnSync } from 'child_process'
import { execFile } from 'mz/child_process'
import * as path from 'path'
import * as fs from 'fs'
import { Subject, throttleTime } from 'rxjs'

import { saveConfig } from './config'
import { Window, WindowOptions } from './window'
import { pluginManager } from './pluginManager'
import { PTYManager } from './pty'
import { PostgresSyncService } from './postgresSync'
import { LLMAssistantService } from './llmAssistant'
import { VoiceTranscriptionService } from './voiceTranscription'
import { LocalCommandHistoryService } from './commandHistory'

/* eslint-disable block-scoped-var */

try {
    var wnr = require('windows-native-registry') // eslint-disable-line @typescript-eslint/no-var-requires, no-var
} catch (_) { }

export class Application {
    private tray?: Tray
    private ptyManager = new PTYManager()
    private postgresSync = new PostgresSyncService()
    private llmAssistant = new LLMAssistantService()
    private voiceTranscription = new VoiceTranscriptionService()
    private commandHistory = new LocalCommandHistoryService()
    private windows: Window[] = []
    private cachedPlasmaVersion?: [number, number] | null
    private globalHotkey$ = new Subject<void>()
    private quitRequested = false
    userPluginsPath: string

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    constructor (private configStore: any) {
        remote.initialize()
        this.useBuiltinGraphics()
        this.ptyManager.init(this)

        ipcMain.handle('app:save-config', async (event, config) => {
            await saveConfig(config)
            this.broadcastExcept('host:config-change', event.sender, config)
        })

        ipcMain.handle('postgres-sync:save-password', async (_event, connection, password) => {
            await this.postgresSync.savePassword(connection, password)
        })
        ipcMain.handle('postgres-sync:get-password', async (_event, connection) => {
            return await this.postgresSync.getPassword(connection)
        })
        ipcMain.handle('postgres-sync:clear-password', async (_event, connection) => {
            await this.postgresSync.clearPassword(connection)
        })
        ipcMain.handle('postgres-sync:test', async (_event, connection) => this.postgresSync.test(connection))
        ipcMain.handle('postgres-sync:sync', async (_event, request) => this.postgresSync.sync(request))

        ipcMain.handle('llm-assistant:test', async (_event, connection) => this.llmAssistant.test(connection))
        ipcMain.handle('llm-assistant:save-api-key', async (_event, connection, apiKey) => this.llmAssistant.saveApiKey(connection, apiKey))
        ipcMain.handle('llm-assistant:clear-api-key', async (_event, connection) => this.llmAssistant.clearApiKey(connection))
        ipcMain.handle('llm-assistant:has-api-key', async (_event, connection) => this.llmAssistant.hasApiKey(connection))
        ipcMain.handle('llm-assistant:ask', async (_event, request) => this.llmAssistant.ask(request.connection, request.question, request.context, request.regeneration))
        ipcMain.handle('llm-assistant:local-context', async (_event, requestedPath?: string) => {
            const cwd = typeof requestedPath === 'string' && path.isAbsolute(requestedPath) ? requestedPath : app.getPath('home')
            try {
                const entries = (await fs.promises.readdir(cwd, { withFileTypes: true }))
                    .slice(0, 80)
                    .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
                return { cwd, directoryEntries: entries, platform: process.platform }
            } catch {
                return { cwd, directoryEntries: [], platform: process.platform }
            }
        })
        ipcMain.handle('terminal-path:list', async (_event, request?: { cwd?: string, typedPath?: string }) => {
            const cwd = typeof request?.cwd === 'string' && path.isAbsolute(request.cwd) ? request.cwd : app.getPath('home')
            const home = app.getPath('home')
            const typedPath = String(request?.typedPath ?? '')
            const separators = process.platform === 'win32' ? /[\\/]/ : /\//
            let separatorIndex = -1
            for (let index = typedPath.length - 1; index >= 0; index--) {
                if (separators.test(typedPath[index])) { separatorIndex = index; break }
            }
            const parentValue = separatorIndex >= 0 ? typedPath.slice(0, separatorIndex + 1) : ''
            const fragment = separatorIndex >= 0 ? typedPath.slice(separatorIndex + 1) : typedPath
            const displaySeparator = process.platform === 'win32' && typedPath.includes('\\') ? '\\' : '/'
            let parentPath = parentValue
            if (parentPath === '~' || parentPath.startsWith(`~${displaySeparator}`)) {
                parentPath = path.join(home, parentPath.slice(2))
            }
            const directory = path.resolve(cwd, parentPath || '.')
            const entries = await fs.promises.readdir(directory, { withFileTypes: true })
            const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
            const needle = caseInsensitive ? fragment.toLocaleLowerCase() : fragment
            const directories = (await Promise.all(entries.map(async entry => {
                const candidate = caseInsensitive ? entry.name.toLocaleLowerCase() : entry.name
                if ((!fragment.startsWith('.') && entry.name.startsWith('.')) || !candidate.startsWith(needle)) { return null }
                let isDirectory = entry.isDirectory()
                if (!isDirectory && entry.isSymbolicLink()) {
                    isDirectory = await fs.promises.stat(path.join(directory, entry.name)).then(stat => stat.isDirectory()).catch(() => false)
                }
                if (!isDirectory) { return null }
                return {
                    name: entry.name,
                    value: `${parentValue}${entry.name}${displaySeparator}`,
                    fullPath: path.join(directory, entry.name),
                }
            }))).filter(Boolean) as Array<{ name: string, value: string, fullPath: string }>
            directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
            if (!fragment || '..'.startsWith(fragment)) {
                directories.push({ name: '..', value: `${parentValue}..${displaySeparator}`, fullPath: path.resolve(directory, '..') })
            }
            return directories.slice(0, 16)
        })
        ipcMain.handle('voice-transcription:status', async (_event, config) => this.voiceTranscription.status(config))
        ipcMain.handle('voice-transcription:transcribe', async (_event, audio, config) => this.voiceTranscription.transcribe(audio, config))
        ipcMain.handle('command-history:list', async (_event, legacyEntries, limit) => this.commandHistory.list(legacyEntries, limit))
        ipcMain.handle('command-history:add', async (_event, entry, limit) => {
            const entries = await this.commandHistory.add(entry, limit)
            this.broadcast('command-history:changed', entries)
            return entries
        })
        ipcMain.handle('command-history:clear', async () => {
            const entries = await this.commandHistory.clear()
            this.broadcast('command-history:changed', entries)
            return entries
        })
        ipcMain.handle('sftp-local:list', async (_event, requestedPath?: string) => {
            const target = typeof requestedPath === 'string' && path.isAbsolute(requestedPath) ? requestedPath : app.getPath('home')
            const resolved = path.resolve(target)
            const entries = await fs.promises.readdir(resolved, { withFileTypes: true })
            const files = await Promise.all(entries.map(async entry => {
                const fullPath = path.join(resolved, entry.name)
                const stat = await fs.promises.lstat(fullPath).catch(() => null)
                return {
                    name: entry.name,
                    fullPath,
                    isDirectory: entry.isDirectory(),
                    isSymlink: entry.isSymbolicLink(),
                    size: stat?.size ?? 0,
                    modified: stat?.mtimeMs ?? 0,
                    mode: stat?.mode ?? (entry.isDirectory() ? 0o755 : 0o644),
                }
            }))
            return { path: resolved, files }
        })
        ipcMain.handle('sftp-local:read-file', async (_event, requestedPath: string) => {
            if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
                throw new Error('An absolute local file path is required')
            }
            return fs.promises.readFile(path.resolve(requestedPath))
        })
        ipcMain.handle('sftp-local:write-file', async (_event, requestedDirectory: string, requestedName: string, bytes: Uint8Array) => {
            if (typeof requestedDirectory !== 'string' || !path.isAbsolute(requestedDirectory)) {
                throw new Error('An absolute local destination is required')
            }
            const directory = path.resolve(requestedDirectory)
            const safeName = path.basename(String(requestedName || 'download'))
            const extension = path.extname(safeName)
            const stem = path.basename(safeName, extension)
            for (let suffix = 0; ; suffix++) {
                const fileName = suffix === 0 ? safeName : `${stem} copy${suffix === 1 ? '' : ` ${suffix}`}${extension}`
                const destination = path.join(directory, fileName)
                try {
                    await fs.promises.writeFile(destination, Buffer.from(bytes), { flag: 'wx' })
                    return destination
                } catch (error: any) {
                    if (error?.code !== 'EEXIST') { throw error }
                }
            }
        })
        ipcMain.handle('sftp-local:mkdir', async (_event, requestedDirectory: string, requestedName: string) => {
            if (typeof requestedDirectory !== 'string' || !path.isAbsolute(requestedDirectory)) {
                throw new Error('An absolute local destination is required')
            }
            const directory = path.resolve(requestedDirectory)
            const safeName = path.basename(String(requestedName || 'New folder'))
            for (let suffix = 0; ; suffix++) {
                const directoryName = suffix === 0 ? safeName : `${safeName} copy${suffix === 1 ? '' : ` ${suffix}`}`
                const destination = path.join(directory, directoryName)
                try {
                    await fs.promises.mkdir(destination)
                    return destination
                } catch (error: any) {
                    if (error?.code !== 'EEXIST') { throw error }
                }
            }
        })
        ipcMain.handle('sftp-local:rename', async (_event, requestedPath: string, requestedName: string) => {
            if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
                throw new Error('An absolute local path is required')
            }
            const source = path.resolve(requestedPath)
            const safeName = path.basename(String(requestedName || ''))
            if (!safeName) { throw new Error('A file name is required') }
            const destination = path.join(path.dirname(source), safeName)
            if (destination === source) { return destination }
            if (await fs.promises.lstat(destination).then(() => true).catch(() => false)) {
                throw new Error(`“${safeName}” already exists`)
            }
            await fs.promises.rename(source, destination)
            return destination
        })
        ipcMain.handle('sftp-local:remove', async (_event, requestedPath: string) => {
            if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
                throw new Error('An absolute local path is required')
            }
            const target = path.resolve(requestedPath)
            if (target === path.parse(target).root) { throw new Error('Refusing to remove a filesystem root') }
            await fs.promises.rm(target, { recursive: true, force: false })
        })
        ipcMain.handle('ssh-local:list-keys', async () => {
            const sshDirectory = path.join(app.getPath('home'), '.ssh')
            const entries = await fs.promises.readdir(sshDirectory, { withFileTypes: true }).catch(() => [])
            const publicKeys = new Set(entries
                .filter(entry => entry.isFile() && entry.name.endsWith('.pub'))
                .map(entry => entry.name.slice(0, -4)))
            return entries
                .filter(entry => entry.isFile())
                .map(entry => entry.name)
                .filter(name => !name.endsWith('.pub') && (publicKeys.has(name) || /^(id_|.*\.(pem|key|ppk)$)/i.test(name)))
                .sort((a, b) => a.localeCompare(b))
        })

        ipcMain.on('app:register-global-hotkey', (_event, specs) => {
            globalShortcut.unregisterAll()
            if (!this.shouldRegisterGlobalHotkeys()) {
                return
            }
            for (const spec of specs) {
                globalShortcut.register(spec, () => this.globalHotkey$.next())
            }
        })

        this.globalHotkey$.pipe(throttleTime(100)).subscribe(() => {
            this.onGlobalHotkey()
        })

        ;(promiseIpc as any).on('plugin-manager:install', (name, version) => {
            return pluginManager.install(this.userPluginsPath, name, version)
        })

        ;(promiseIpc as any).on('plugin-manager:uninstall', (name) => {
            return pluginManager.uninstall(this.userPluginsPath, name)
        })

        ;(promiseIpc as any).on('get-default-mac-shell', async () => {
            try {
                return (await execFile('/usr/bin/dscl', ['.', '-read', `/Users/${process.env.LOGNAME}`, 'UserShell']))[0].toString().split(' ')[1].trim()
            } catch {
                return '/bin/bash'
            }
        })

        if (process.platform === 'linux') {
            app.commandLine.appendSwitch('no-sandbox')
            if ((this.configStore.appearance?.opacity || 1) !== 1) {
                app.commandLine.appendSwitch('enable-transparent-visuals')
                app.disableHardwareAcceleration()
            }
        }
        if (this.configStore.hacks?.disableGPU) {
            app.commandLine.appendSwitch('disable-gpu')
            app.disableHardwareAcceleration()
        }

        this.userPluginsPath = path.join(
            app.getPath('userData'),
            'plugins',
        )

        if (!fs.existsSync(this.userPluginsPath)) {
            fs.mkdirSync(this.userPluginsPath)
        }

        app.commandLine.appendSwitch('disable-http-cache')
        app.commandLine.appendSwitch('max-active-webgl-contexts', '9000')
        app.commandLine.appendSwitch('lang', 'EN')

        for (const flag of this.configStore.flags || [['force_discrete_gpu', '0']]) {
            app.commandLine.appendSwitch(flag[0], flag[1])
        }

        app.on('before-quit', () => {
            this.quitRequested = true
        })

        app.on('window-all-closed', () => {
            if (this.quitRequested || process.platform !== 'darwin') {
                app.quit()
            }
        })
    }

    init (): void {
        screen.on('display-metrics-changed', () => this.broadcast('host:display-metrics-changed'))
        screen.on('display-added', () => this.broadcast('host:displays-changed'))
        screen.on('display-removed', () => this.broadcast('host:displays-changed'))
    }

    async newWindow (options?: WindowOptions): Promise<Window> {
        const window = new Window(this, this.configStore, options)
        this.windows.push(window)
        if (this.windows.length === 1) {
            window.makeMain()
        }
        window.visible$.subscribe(visible => {
            if (visible) {
                this.disableTray()
            } else {
                this.enableTray()
            }
        })
        window.closed$.subscribe(() => {
            this.windows = this.windows.filter(x => x !== window)
            if (!this.windows.some(x => x.isMainWindow)) {
                this.windows[0]?.makeMain()
                this.windows[0]?.present()
            }
        })
        if (process.platform === 'darwin') {
            this.setupMenu()
        }
        await window.ready
        return window
    }

    onGlobalHotkey (): void {
        let isPresent = this.windows.some(x => x.isFocused() && x.isVisible())
        const isDockedOnTop = this.windows.some(x => x.isDockedOnTop())
        if (isDockedOnTop) {
            // if docked and on top, hide even if not focused right now
            isPresent = this.windows.some(x => x.isVisible())
        }

        if (isPresent) {
            for (const window of this.windows) {
                window.hide()
            }
        } else {
            for (const window of this.windows) {
                window.present()
            }
        }
    }

    presentAllWindows (): void {
        for (const window of this.windows) {
            window.present()
        }
    }

    broadcast (event: string, ...args: any[]): void {
        for (const window of this.windows) {
            window.send(event, ...args)
        }
    }

    broadcastExcept (event: string, except: WebContents, ...args: any[]): void {
        for (const window of this.windows) {
            if (window.webContents.id !== except.id) {
                window.send(event, ...args)
            }
        }
    }

    async send (event: string, ...args: any[]): Promise<void> {
        if (!this.hasWindows()) {
            await this.newWindow()
        }
        this.windows.filter(w => !w.isDestroyed())[0].send(event, ...args)
    }

    enableTray (): void {
        if (!!this.tray || process.platform === 'linux' || (this.configStore.hideTray ?? false) === true) {
            return
        }

        if (process.platform === 'darwin') {
            this.tray = new Tray(`${app.getAppPath()}/assets/tray-darwinTemplate.png`)
            this.tray.setPressedImage(`${app.getAppPath()}/assets/tray-darwinHighlightTemplate.png`)
        } else {
            this.tray = new Tray(`${app.getAppPath()}/assets/tray.png`)
        }

        this.tray.on('click', () => setTimeout(() => this.focus()))

        const contextMenu = Menu.buildFromTemplate([{
            label: 'Show',
            click: () => this.focus(),
        }])

        if (process.platform !== 'darwin') {
            this.tray.setContextMenu(contextMenu)
        }

        this.tray.setToolTip(`Tabby ${app.getVersion()}`)
    }

    disableTray (): void {
        if (process.platform === 'linux') {
            return
        }
        this.tray?.destroy()
        this.tray = null
    }

    hasWindows (): boolean {
        return !!this.windows.length
    }

    private shouldRegisterGlobalHotkeys (): boolean {
        const hotkeyMode = this.configStore.hacks?.globalHotkey
        if (hotkeyMode != null) {
            return !hotkeyMode
        }

        if (process.platform !== 'linux' || !this.isWaylandSession() || !this.isPlasmaSession()) {
            return true
        }

        const plasmaVersion = this.getPlasmaVersion()
        return plasmaVersion ? this.compareVersions(plasmaVersion, [6, 6]) >= 0 : false
    }

    private isWaylandSession (): boolean {
        return (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' || !!process.env.WAYLAND_DISPLAY
    }

    private isPlasmaSession (): boolean {
        const sessionInfo = [
            process.env.XDG_CURRENT_DESKTOP,
            process.env.DESKTOP_SESSION,
            process.env.GDMSESSION,
        ].join(':').toLowerCase()

        return process.env.KDE_FULL_SESSION === 'true' || sessionInfo.includes('kde') || sessionInfo.includes('plasma')
    }

    private getPlasmaVersion (): [number, number] | null {
        if (this.cachedPlasmaVersion !== undefined) {
            return this.cachedPlasmaVersion
        }
        try {
            const result = spawnSync('plasmashell', ['--version'], { encoding: 'utf8' })
            const output = result.stdout + result.stderr
            const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output)
            this.cachedPlasmaVersion = match ? [
                parseInt(match[1], 10),
                parseInt(match[2], 10),
            ] : null
        } catch {
            this.cachedPlasmaVersion = null
        }
        return this.cachedPlasmaVersion ?? null
    }

    private compareVersions (a: [number, number], b: [number, number]): number {
        for (let i = 0; i < 2; i++) {
            if (a[i] !== b[i]) {
                return a[i] - b[i]
            }
        }
        return 0
    }

    focus (): void {
        for (const window of this.windows) {
            window.present()
        }
    }

    async handleSecondInstance (argv: string[], cwd: string): Promise<void> {
        if (!this.windows.length) {
            await this.newWindow()
        }
        this.presentAllWindows()
        this.windows[this.windows.length - 1].passCliArguments(argv, cwd, true)
    }

    private useBuiltinGraphics (): void {
        if (process.platform === 'win32') {
            const keyPath = 'SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences'
            const valueName = app.getPath('exe')
            if (!wnr.getRegistryValue(wnr.HK.CU, keyPath, valueName)) {
                wnr.setRegistryValue(wnr.HK.CU, keyPath, valueName, wnr.REG.SZ, 'GpuPreference=1;')
            }
        }
    }

    private setupMenu () {
        const template: MenuItemConstructorOptions[] = [
            {
                label: 'Application',
                submenu: [
                    { role: 'about', label: 'About Tabby' },
                    { type: 'separator' },
                    {
                        label: 'Preferences',
                        accelerator: 'Cmd+,',
                        click: async () => {
                            if (!this.hasWindows()) {
                                await this.newWindow()
                            }
                            this.windows[0].send('host:preferences-menu')
                        },
                    },
                    { type: 'separator' },
                    { role: 'services', submenu: [] },
                    { type: 'separator' },
                    { role: 'hide' },
                    { role: 'hideOthers' },
                    { role: 'unhide' },
                    { type: 'separator' },
                    {
                        label: 'Quit',
                        accelerator: 'Cmd+Q',
                        click: () => {
                            this.quitRequested = true
                            app.quit()
                        },
                    },
                ],
            },
            {
                label: 'Edit',
                submenu: [
                    { role: 'undo' },
                    { role: 'redo' },
                    { type: 'separator' },
                    { role: 'cut' },
                    { role: 'copy' },
                    { role: 'paste' },
                    { role: 'pasteAndMatchStyle' },
                    { role: 'delete' },
                    { role: 'selectAll' },
                ],
            },
            {
                label: 'View',
                submenu: [
                    { role: 'toggleDevTools' },
                    { type: 'separator' },
                    { role: 'togglefullscreen' },
                ],
            },
            {
                role: 'window',
                submenu: [
                    { role: 'minimize' },
                    { role: 'zoom' },
                    { type: 'separator' },
                    { role: 'front' },
                ],
            },
            {
                role: 'help',
                submenu: [
                    {
                        label: 'Website',
                        click () {
                            shell.openExternal('https://eugeny.github.io/tabby')
                        },
                    },
                ],
            },
        ]

        if (process.env.TABBY_DEV) {
            template[2].submenu['unshift']({ role: 'reload' })
        }

        Menu.setApplicationMenu(Menu.buildFromTemplate(template))
    }
}
