import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '../../../')
const CLI_PATH = join(PROJECT_ROOT, 'dist', 'cli.js')

export interface CliRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  combined: string
}

// Auth env vars that could be present in a developer's shell and silently
// make "no auth" scenarios pass against a real wallet. Always stripped
// before spawning so every test is hermetic regardless of where it runs.
const STRIP_AUTH = ['PRIVATE_KEY', 'SESSION_KEY', 'WALLET_ADDRESS'] as const

export async function runCli(args: string[] = [], env: Record<string, string> = {}): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    // Inherit the process env so the CLI can initialize correctly (HOME,
    // TEMP, etc.), strip auth keys for hermeticity, then apply caller
    // overrides so individual tests can inject specific vars (e.g. PR 2
    // network tests passing PRIVATE_KEY).
    const baseEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) baseEnv[k] = v
    }
    for (const key of STRIP_AUTH) {
      delete baseEnv[key]
    }

    const child = spawn('node', [CLI_PATH, '--no-update-check', ...args], {
      cwd: PROJECT_ROOT,
      env: { ...baseEnv, ...env },
      stdio: 'pipe',
    })

    let stdout = ''
    let stderr = ''
    let combined = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (data) => {
      stdout += data
      combined += data
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (data) => {
      stderr += data
      combined += data
    })

    child.on('error', reject)

    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr, combined })
    })
  })
}
