import * as keytar from 'keytar'

export type LLMProvider = 'ollama'|'openWebUI'

export interface LLMConnection {
    enabled: boolean
    provider?: LLMProvider
    baseUrl: string
    model: string
    apiKeySaved?: boolean
}

export interface LLMModel {
    name: string
    model: string
    modifiedAt?: string
    size?: number
    parameterSize?: string
    quantizationLevel?: string
}

export interface AssistantContext {
    platform: string
    arch: string
    cwd?: string
    directoryEntries?: string[]
    remote?: boolean
    shell?: string
}

export interface AssistantRegeneration {
    previousCommand: string
    attempt: number
}

const MAX_CONTEXT_ENTRIES = 80
const KEYTAR_SERVICE = 'Tabby Sync AI assistant'

/**
 * LLM integration lives in the main process so local services are reachable
 * without renderer CORS limitations. Open WebUI API keys remain in the OS
 * keychain and are never exposed back to a renderer or stored in config.
 */
export class LLMAssistantService {
    async saveApiKey (connection: LLMConnection, apiKey: string): Promise<void> {
        const value = String(apiKey ?? '').trim()
        if (!value) { return }
        await keytar.setPassword(KEYTAR_SERVICE, this.account(connection), value)
    }

    async clearApiKey (connection: LLMConnection): Promise<void> {
        await keytar.deletePassword(KEYTAR_SERVICE, this.account(connection))
    }

    async hasApiKey (connection: LLMConnection): Promise<boolean> {
        if (this.provider(connection) !== 'openWebUI' || !String(connection.baseUrl ?? '').trim()) { return false }
        return !!(await keytar.getPassword(KEYTAR_SERVICE, this.account(connection)))
    }

    async test (connection: LLMConnection): Promise<{ provider: LLMProvider, baseUrl: string, models: LLMModel[], apiKeySaved: boolean }> {
        const provider = this.provider(connection)
        const baseUrl = this.normalizeBaseUrl(connection.baseUrl, provider)
        const apiKey = provider === 'openWebUI' ? await keytar.getPassword(KEYTAR_SERVICE, this.account({ ...connection, baseUrl })) : null
        return {
            provider,
            baseUrl,
            models: await this.listModels(provider, baseUrl, apiKey),
            apiKeySaved: !!apiKey,
        }
    }

    async ask (connection: LLMConnection, question: string, context: AssistantContext, regeneration?: AssistantRegeneration): Promise<{ command: string, explanation: string, raw: string }> {
        if (!question.trim()) {
            throw new Error('Enter a request for the assistant.')
        }
        const provider = this.provider(connection)
        if (!connection.enabled || !connection.model?.trim()) {
            throw new Error(`Configure a ${this.providerName(provider)} server and model, then enable the AI assistant in Settings.`)
        }
        const baseUrl = this.normalizeBaseUrl(connection.baseUrl, provider)
        const apiKey = provider === 'openWebUI' ? await keytar.getPassword(KEYTAR_SERVICE, this.account({ ...connection, baseUrl })) : null
        const raw = await this.chat(provider, baseUrl, connection.model.trim(), question, {
            ...context,
            directoryEntries: (context.directoryEntries ?? []).slice(0, MAX_CONTEXT_ENTRIES),
        }, apiKey, regeneration)
        return { ...this.parseResponse(raw), raw }
    }

    private async listModels (provider: LLMProvider, baseUrl: string, apiKey: string|null): Promise<LLMModel[]> {
        if (provider === 'ollama') {
            const body = await this.fetchJSON(`${baseUrl}/api/tags`, { method: 'GET' }, 10000, provider)
            if (!Array.isArray(body?.models)) {
                throw new Error('Ollama returned an invalid model list.')
            }
            return body.models
                .filter((model: any) => typeof model?.name === 'string' || typeof model?.model === 'string')
                .map((model: any) => ({
                    name: String(model.name ?? model.model),
                    model: String(model.model ?? model.name),
                    modifiedAt: typeof model.modified_at === 'string' ? model.modified_at : undefined,
                    size: typeof model.size === 'number' ? model.size : undefined,
                    parameterSize: typeof model.details?.parameter_size === 'string' ? model.details.parameter_size : undefined,
                    quantizationLevel: typeof model.details?.quantization_level === 'string' ? model.details.quantization_level : undefined,
                }))
                .sort((a: LLMModel, b: LLMModel) => a.name.localeCompare(b.name))
        }

        const body = await this.fetchJSON(`${baseUrl}/api/models`, {
            method: 'GET',
            headers: this.openWebUIHeaders(apiKey),
        }, 10000, provider)
        const values = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null
        if (!values) {
            throw new Error('Open WebUI returned an invalid model list.')
        }
        return values
            .filter((model: any) => typeof model?.id === 'string' || typeof model?.model === 'string' || typeof model?.name === 'string')
            .map((model: any) => ({
                name: String(model.name ?? model.id ?? model.model),
                model: String(model.id ?? model.model ?? model.name),
            }))
            .sort((a: LLMModel, b: LLMModel) => a.name.localeCompare(b.name))
    }

    private async chat (provider: LLMProvider, baseUrl: string, model: string, question: string, context: AssistantContext, apiKey: string|null, regeneration?: AssistantRegeneration): Promise<string> {
        const messages = [
            {
                role: 'system',
                content: 'You are a terminal command assistant. Return ONLY valid JSON: {"command":"single safe command or empty string","explanation":"short Russian explanation"}. Never claim that a command ran. Prefer commands that inspect before changing state. Do not put markdown fences in command.' + (regeneration ? ' This is a regeneration request: return a different valid command when a reasonable alternative exists.' : ''),
            },
            {
                role: 'user',
                content: JSON.stringify({
                    request: question,
                    executionContext: context,
                    previousCommandToAvoid: regeneration?.previousCommand,
                    regenerationAttempt: regeneration?.attempt,
                }),
            },
        ]

        const temperature = regeneration ? 0.35 : 0.1

        if (provider === 'ollama') {
            const body = await this.fetchJSON(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model, stream: false, options: { temperature }, messages }),
            }, 60000, provider)
            const content = body?.message?.content
            if (typeof content !== 'string') {
                throw new Error('Ollama returned no command response.')
            }
            return content
        }

        const body = await this.fetchJSON(`${baseUrl}/api/chat/completions`, {
            method: 'POST',
            headers: this.openWebUIHeaders(apiKey, true),
            body: JSON.stringify({ model, stream: false, temperature, messages }),
        }, 60000, provider)
        const content = body?.choices?.[0]?.message?.content
        if (typeof content === 'string') { return content }
        if (Array.isArray(content)) {
            const text = content.filter((part: any) => typeof part?.text === 'string').map((part: any) => part.text).join('')
            if (text) { return text }
        }
        throw new Error('Open WebUI returned no command response.')
    }

    private openWebUIHeaders (apiKey: string|null, json = false): Record<string, string> {
        const headers: Record<string, string> = {}
        if (json) { headers['content-type'] = 'application/json' }
        if (apiKey) { headers.authorization = `Bearer ${apiKey}` }
        return headers
    }

    private async fetchJSON (url: string, init: RequestInit, timeoutMs: number, provider: LLMProvider): Promise<any> {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)
        const name = this.providerName(provider)
        try {
            const response = await fetch(url, { ...init, signal: controller.signal })
            const body = await response.json().catch(() => null)
            if (!response.ok) {
                const message = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.detail
                throw new Error(message ?? `${name} returned HTTP ${response.status}`)
            }
            return body
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                throw new Error(`${name} did not respond before the connection timed out.`)
            }
            if (String(error?.message ?? '').startsWith(`${name} `)) {
                throw error
            }
            throw new Error(`Could not connect to ${name} at ${url}: ${error?.message ?? String(error)}`)
        } finally {
            clearTimeout(timeout)
        }
    }

    private normalizeBaseUrl (input: string, provider: LLMProvider): string {
        let value = String(input ?? '').trim()
        const name = this.providerName(provider)
        if (!value) {
            throw new Error(`Enter the ${name} server IP or URL first.`)
        }
        const hadScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
        if (!hadScheme) {
            value = `http://${value}`
        }
        let url: URL
        try {
            url = new URL(value)
        } catch {
            const example = provider === 'ollama' ? '192.168.1.20:11434' : '192.168.1.20:3000'
            throw new Error(`Enter a valid ${name} server, for example ${example}.`)
        }
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
            throw new Error(`${name} server must use an http:// or https:// address.`)
        }
        if (provider === 'ollama' && !url.port && (!hadScheme || url.protocol === 'http:')) {
            url.port = '11434'
        }
        url.search = ''
        url.hash = ''
        const removable = provider === 'ollama'
            ? /\/(?:api(?:\/tags|\/chat)?)?\/*$/
            : /\/(?:api(?:\/models|\/chat\/completions)?)?\/*$/
        url.pathname = url.pathname.replace(removable, '').replace(/\/+$/, '')
        return url.toString().replace(/\/$/, '')
    }

    private account (connection: LLMConnection): string {
        const provider = this.provider(connection)
        return `${provider}:${this.normalizeBaseUrl(connection.baseUrl, provider)}`
    }

    private provider (connection: LLMConnection): LLMProvider {
        return connection.provider === 'openWebUI' ? 'openWebUI' : 'ollama'
    }

    private providerName (provider: LLMProvider): string {
        return provider === 'openWebUI' ? 'Open WebUI' : 'Ollama'
    }

    private parseResponse (raw: string): { command: string, explanation: string } {
        const unwrapped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        try {
            const value = JSON.parse(unwrapped)
            return {
                command: typeof value.command === 'string' ? value.command.trim() : '',
                explanation: typeof value.explanation === 'string' ? value.explanation.trim() : '',
            }
        } catch {
            return { command: '', explanation: raw.trim() }
        }
    }
}
