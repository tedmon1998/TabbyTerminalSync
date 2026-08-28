import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface VoiceInputConfig {
    enabled: boolean
    runtimePath?: string
    modelPath?: string
    maxRecordingSeconds?: number
}

function decodeOctalUTF8Runs (value: string): string {
    return value.replace(/(?:\\[0-3][0-7]{2}){2,}/g, sequence => {
        const bytes = sequence.match(/[0-3][0-7]{2}/g)?.map(octal => parseInt(octal, 8)) ?? []
        const decoded = Buffer.from(bytes).toString('utf8')
        return decoded.includes('\uFFFD') ? sequence : decoded
    })
}

/** Converts runtime output into a single safe, editable terminal line. */
export function normalizeVoiceTranscript (raw: Buffer|string): string {
    let value = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
    value = decodeOctalUTF8Runs(value.replace(/^\uFEFF/, ''))
    return value
        .normalize('NFC')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\s*\n+\s*/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
}

/** Runs the bundled GigaAM-v3 E2E CTC Q4 model fully locally. */
export class VoiceTranscriptionService {
    async status (config: VoiceInputConfig): Promise<{ runtimePath: string, modelPath: string, ready: boolean }> {
        const runtimePath = this.runtimePath(config)
        const modelPath = this.modelPath(config)
        return { runtimePath, modelPath, ready: fs.existsSync(runtimePath) && fs.existsSync(modelPath) }
    }

    async transcribe (audio: Uint8Array|ArrayBuffer, config: VoiceInputConfig): Promise<string> {
        if (!config.enabled) {
            throw new Error('Voice input is disabled in Settings.')
        }
        const { runtimePath, modelPath, ready } = await this.status(config)
        if (!ready) {
            throw new Error('GigaAM runtime or Q4 model was not found. Check Voice input settings.')
        }
        const payload = audio instanceof ArrayBuffer ? Buffer.from(audio) : Buffer.from(audio)
        if (payload.length < 48) {
            throw new Error('No microphone audio was captured.')
        }
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-voice-'))
        const wav = path.join(dir, `${randomUUID()}.wav`)
        const output = path.join(dir, `${randomUUID()}.txt`)
        try {
            await fs.promises.writeFile(wav, payload, { mode: 0o600 })
            await this.run(runtimePath, ['--quiet', '--timestamps', 'none', '--backend', 'auto', '-l', 'ru', '-m', modelPath, '-o', output, wav])
            return normalizeVoiceTranscript(await fs.promises.readFile(output))
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
        }
    }

    private runtimePath (config: VoiceInputConfig): string {
        if (config.runtimePath?.trim()) { return config.runtimePath.trim() }
        if (process.platform === 'darwin' && process.arch === 'arm64') {
            return path.join(process.resourcesPath, 'extras', 'voice', 'macos-arm64', 'transcribe-cli')
        }
        return ''
    }

    private modelPath (config: VoiceInputConfig): string {
        if (config.modelPath?.trim()) { return config.modelPath.trim() }
        return path.join(process.resourcesPath, 'extras', 'voice', 'gigaam-v3-e2e-ctc-Q4_K_M.gguf')
    }

    private run (command: string, args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
            let stderr = ''
            const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
            child.stderr?.on('data', data => { stderr += data.toString() })
            child.once('error', error => { clearTimeout(timer); reject(error) })
            child.once('close', code => {
                clearTimeout(timer)
                if (code === 0) { resolve() } else { reject(new Error(stderr.trim() || `GigaAM exited with code ${code}`)) }
            })
        })
    }
}
