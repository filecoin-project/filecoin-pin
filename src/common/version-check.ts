import pc from 'picocolors'
import { compare } from 'semver'
import { name as packageName, version as packageVersion } from '../core/utils/version.js'
import { isTTY } from '../utils/cli-logger.js'

type UpdateCheckStatus =
  | {
      status: 'disabled'
      reason: string
    }
  | {
      status: 'up-to-date'
      currentVersion: string
      latestVersion: string
    }
  | {
      status: 'update-available'
      currentVersion: string
      latestVersion: string
    }
  | {
      status: 'error'
      currentVersion: string
      message: string
    }

type CheckForUpdateOptions = {
  packageName?: string
  currentVersion?: string
  timeoutMs?: number
  disableCheck?: boolean
}

const DEFAULT_PACKAGE_NAME = packageName
const DEFAULT_TIMEOUT_MS = 1500
export async function checkForUpdate(options: CheckForUpdateOptions = {}): Promise<UpdateCheckStatus> {
  const { packageName = DEFAULT_PACKAGE_NAME, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const disableCheck = options.disableCheck === true

  if (disableCheck) {
    return {
      status: 'disabled',
      reason: 'Update check disabled by configuration',
    }
  }

  const currentVersion = options.currentVersion ?? getLocalPackageVersion()

  const signal = AbortSignal.timeout(timeoutMs)

  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal,
      headers: {
        accept: 'application/json',
      },
    })

    if (!response.ok) {
      return {
        status: 'error',
        currentVersion,
        message: `Received ${response.status} from npm registry`,
      }
    }

    const data = (await response.json()) as { version?: string }

    if (typeof data.version !== 'string') {
      return {
        status: 'error',
        currentVersion,
        message: 'Response missing version field',
      }
    }

    const latestVersion = data.version

    if (compare(latestVersion, currentVersion) > 0) {
      return {
        status: 'update-available',
        currentVersion,
        latestVersion,
      }
    }

    return {
      status: 'up-to-date',
      currentVersion,
      latestVersion,
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        status: 'error',
        currentVersion,
        message: 'Update check timed out',
      }
    }

    return {
      status: 'error',
      currentVersion,
      message: error instanceof Error ? error.message : 'Unknown error during update check',
    }
  }
}

function getLocalPackageVersion(): string {
  return packageVersion
}

/**
 * Print the "update available" banner, but only on an interactive TTY.
 *
 * When stdout is piped (CI, scripts, `| jq`, etc.) the banner is noise that can
 * corrupt machine-readable output, so it is suppressed. `print` and `tty` are
 * injectable for testing.
 */
export function printUpdateBanner(
  result: UpdateCheckStatus,
  { tty = isTTY(), print = console.log }: { tty?: boolean; print?: (message: string) => void } = {}
): void {
  if (result.status !== 'update-available' || !tty) {
    return
  }

  const header = `${pc.yellow(`Update available: filecoin-pin ${result.currentVersion} → ${result.latestVersion}`)}. Upgrade with ${pc.cyan('npm i -g filecoin-pin@latest')}`
  const releasesLink = 'https://github.com/filecoin-project/filecoin-pin/releases'
  const instruction = `Visit ${releasesLink} to view release notes or download the latest version.`
  print(header)
  print(instruction)
}

export type { UpdateCheckStatus }
