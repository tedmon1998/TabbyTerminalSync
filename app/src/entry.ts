import 'zone.js'
import 'core-js/proposals/reflect-metadata'
import 'rxjs'

import './global.scss'
import './toastr.scss'

// Importing before @angular/*
import { findPlugins, initModuleLookup, loadPlugins } from './plugins'

import { enableProdMode, NgModuleRef, ApplicationRef } from '@angular/core'
import { enableDebugTools } from '@angular/platform-browser'
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic'
import { ipcRenderer } from 'electron'

import { getRootModule } from './app.module'
import { BootstrapData, BOOTSTRAP_DATA, PluginInfo } from '../../tabby-core/src/api/mainProcess'

// Always land on the start view
location.hash = ''

;(process as any).enablePromiseAPI = true

if (process.platform === 'win32' && !('HOME' in process.env)) {
    process.env.HOME = `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
}

if (process.env.TABBY_DEV && !process.env.TABBY_FORCE_ANGULAR_PROD) {
    console.warn('Running in debug mode')
} else {
    enableProdMode()
}

async function bootstrap (bootstrapData: BootstrapData, plugins: PluginInfo[], safeMode = false): Promise<NgModuleRef<any>> {
    if (safeMode) {
        plugins = plugins.filter(x => x.isBuiltin)
    }

    const pluginModules = await loadPlugins(plugins, (current, total) => {
        (document.querySelector('.progress .bar') as HTMLElement).style.width = `${100 * current / total}%` // eslint-disable-line
    })

    window['pluginModules'] = pluginModules

    const module = getRootModule(pluginModules)
    const moduleRef = await platformBrowserDynamic([
        { provide: BOOTSTRAP_DATA, useValue: bootstrapData },
    ]).bootstrapModule(module)
    if (process.env.TABBY_DEV) {
        const applicationRef = moduleRef.injector.get(ApplicationRef)
        const componentRef = applicationRef.components[0]
        enableDebugTools(componentRef)
    }
    return moduleRef
}

/** Never leave the user staring at an inert splash screen after a fatal bootstrap error. */
function renderFatalBootstrapError (error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const panel = document.createElement('main')
    panel.style.cssText = 'height:100vh;display:grid;place-items:center;padding:32px;background:#111827;color:#f3f4f6;font:15px/1.5 system-ui,sans-serif'
    const card = document.createElement('section')
    card.style.cssText = 'max-width:680px;padding:28px;border:1px solid #374151;border-radius:14px;background:#1f2937;box-shadow:0 20px 50px rgba(0,0,0,.35)'
    const title = document.createElement('h1')
    title.textContent = 'Tabby Sync could not start'
    title.style.cssText = 'margin:0 0 12px;font-size:22px'
    const text = document.createElement('p')
    text.textContent = message
    text.style.cssText = 'margin:0;color:#d1d5db;white-space:pre-wrap;word-break:break-word'
    const hint = document.createElement('p')
    hint.textContent = 'Your configuration was not erased. Restart the app or open the log from ~/Library/Application Support/Tabby Sync/log.txt.'
    hint.style.cssText = 'margin:18px 0 0;color:#93c5fd'
    card.append(title, text, hint)
    panel.append(card)
    document.body.replaceChildren(panel)
}

ipcRenderer.once('start', async (_$event, bootstrapData: BootstrapData) => {
    console.log('Window bootstrap data:', bootstrapData)
    try {
        initModuleLookup(bootstrapData.userPluginsPath)

        let plugins = await findPlugins()
        bootstrapData.installedPlugins = plugins
        if (bootstrapData.config.pluginBlacklist) {
            plugins = plugins.filter(x => !bootstrapData.config.pluginBlacklist.includes(x.name))
        }
        plugins = plugins.filter(x => x.name !== 'web')

        console.log('Starting with plugins:', plugins)
        try {
            await bootstrap(bootstrapData, plugins)
        } catch (error) {
            console.error('Angular bootstrapping error:', error)
            console.warn('Trying safe mode')
            window['safeModeReason'] = error
            try {
                await bootstrap(bootstrapData, plugins, true)
            } catch (error2) {
                console.error('Bootstrap failed:', error2)
                renderFatalBootstrapError(error2)
            }
        }
    } catch (error) {
        console.error('Renderer startup failed:', error)
        renderFatalBootstrapError(error)
    }
})

ipcRenderer.send('ready')
