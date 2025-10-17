import { readFile } from 'node:fs/promises'
import { Octokit } from '@octokit/rest'
import { getErrorMessage } from './errors.js'
import { getInput } from './inputs.js'

/**
 * @typedef {import('./types.js').PRMetadata} PRMetadata
 * @typedef {import('./types.js').CheckContext} CheckContext
 */

/**
 * Read GitHub event payload
 */
export async function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) return {}
  try {
    const content = await readFile(eventPath, 'utf8')
    return JSON.parse(content)
  } catch (error) {
    console.warn('Failed to read event payload:', getErrorMessage(error))
    return {}
  }
}

/**
 * Convert arbitrary numeric value to number when possible
 * @param {unknown} value
 * @returns {number | undefined}
 */
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Normalize PR metadata into CombinedContext.pr shape
 * @param {any} pr
 * @param {string} [fallbackSha]
 * @returns {Partial<PRMetadata> | undefined}
 */
function normalizePr(pr, fallbackSha = '') {
  if (!pr) return undefined
  const number = toNumber(pr.number)
  if (number == null) return undefined

  const sha = pr?.head?.sha || pr?.head_sha || fallbackSha || ''
  const title = pr?.title || ''
  const author = pr?.user?.login || pr?.head?.user?.login || ''

  return { number, sha, title, author }
}

/**
 * Try to resolve PR metadata directly from a workflow_run payload
 * @param {any} workflowRun
 * @returns {Partial<PRMetadata> | undefined}
 */
function resolveFromWorkflowRunPayload(workflowRun) {
  if (!workflowRun) return undefined

  const prList = Array.isArray(workflowRun.pull_requests) ? workflowRun.pull_requests : []
  if (prList.length === 0) return undefined

  /** @type {any} */
  let match
  for (const candidate of prList) {
    if (candidate?.head?.sha && workflowRun.head_sha && candidate.head.sha === workflowRun.head_sha) {
      match = candidate
      break
    }
  }

  const candidate = match || prList[0]
  return normalizePr(candidate, workflowRun.head_sha)
}

/**
 * Use the GitHub API to resolve a PR from workflow_run context
 * @param {Octokit | undefined} octokit
 * @param {any} event
 * @returns {Promise<Partial<PRMetadata> | undefined>}
 */
async function resolveFromWorkflowRunApi(octokit, event) {
  if (!octokit || !event?.workflow_run) return undefined
  const workflowRun = event.workflow_run

  const repoOwner = workflowRun?.repository?.owner?.login || event?.repository?.owner?.login
  const repoName = workflowRun?.repository?.name || event?.repository?.name
  const headOwner = workflowRun?.head_repository?.owner?.login
  const headBranch = workflowRun?.head_branch
  const headSha = workflowRun?.head_sha || ''

  if (!repoOwner || !repoName || !headOwner || !headBranch) return undefined

  try {
    const { data: pulls } = await octokit.rest.pulls.list({
      owner: repoOwner,
      repo: repoName,
      head: `${headOwner}:${headBranch}`,
      state: 'all',
      per_page: 30,
    })

    if (!pulls || pulls.length === 0) return undefined

    const match = pulls.find((pr) => pr?.head?.sha === headSha)
    const candidate = match || pulls[0]
    return normalizePr(candidate, headSha)
  } catch (error) {
    console.warn('Failed to resolve PR info via GitHub API:', getErrorMessage(error))
    return undefined
  }
}

/**
 * Ensure PR metadata is available, resolving it when triggered by workflow_run
 * @param {Partial<PRMetadata> | undefined} existingPr
 * @returns {Promise<Partial<PRMetadata> | undefined>}
 */
export async function ensurePullRequestContext(existingPr) {
  if (existingPr?.number) return existingPr

  const event = await readEventPayload()
  if (!event) return undefined

  let pr = normalizePr(event?.pull_request)

  if (!pr && event?.workflow_run) {
    pr = resolveFromWorkflowRunPayload(event.workflow_run)

    if (!pr) {
      const token = process.env.GITHUB_TOKEN || getInput('github_token') || ''
      const octokit = createOctokit(token) || undefined
      pr = await resolveFromWorkflowRunApi(octokit, event)
    }
  }

  return pr
}

/**
 * Get GitHub environment context from standard GitHub Actions environment variables.
 *
 * Centralizes access to GitHub-specific env vars to avoid duplication and ensure
 * consistent parsing across the codebase.
 *
 * @returns {{ token: string | null, repository: string | null, owner: string | null, repo: string | null, sha: string | null }}
 *   Returns null for any missing values rather than empty strings for safer checks.
 */
export function getGitHubEnv() {
  const token = process.env.GITHUB_TOKEN || null
  const repository = process.env.GITHUB_REPOSITORY || null
  const sha = process.env.GITHUB_SHA || null

  let owner = null
  let repo = null
  if (repository) {
    const parts = repository.split('/')
    owner = parts[0] || null
    repo = parts[1] || null
  }

  return { token, repository, owner, repo, sha }
}

/**
 * Create an authenticated Octokit instance for GitHub API interactions.
 *
 * Centralizes Octokit creation to ensure consistent authentication handling.
 *
 * @param {string | null} [token] - GitHub token (uses env var if not provided)
 * @returns {Octokit | null} Returns null if no token available (graceful degradation)
 */
export function createOctokit(token = null) {
  const authToken = token || process.env.GITHUB_TOKEN
  if (!authToken) {
    return null
  }
  return new Octokit({ auth: authToken })
}

/** @type {CheckContext | null} */
let checkContext = null

/**
 * Initialize GitHub Checks API client with correct SHA resolution.
 *
 * Only creates checks in PR context - gracefully returns null for push events.
 * Automatically resolves the correct commit SHA, handling workflow_run contexts
 * where GITHUB_SHA points to the base branch instead of the PR head.
 *
 * @returns {Promise<CheckContext | null>} Returns null if not in PR context
 */
async function initializeCheckContext() {
  const { token, owner, repo } = getGitHubEnv()

  if (!token) {
    console.log('No GITHUB_TOKEN available - check status will not be created')
    return null
  }

  if (!owner || !repo) {
    console.log('No GITHUB_REPOSITORY or invalid format - check status will not be created')
    return null
  }

  // Resolve correct SHA, especially important for workflow_run triggers
  // where GITHUB_SHA points to base branch, not PR head
  const pr = await ensurePullRequestContext(undefined)

  // Only create checks for PR context - not needed for push to main
  if (!pr?.sha) {
    console.log('No PR context - check status will not be created')
    return null
  }

  const sha = pr.sha

  const octokit = createOctokit(token)
  if (!octokit) {
    return null
  }

  return {
    octokit,
    owner,
    repo,
    sha,
    checkRunId: null,
  }
}

/**
 * Create a check run for the Filecoin upload.
 *
 * Creates a visible check status in the PR's "Checks" tab, similar to other
 * CI/CD integrations. The check shows real-time progress and final results.
 *
 * Only creates checks for PRs - gracefully skips for push events to main.
 * Automatically handles workflow_run contexts by resolving the correct PR head SHA.
 *
 * Gracefully degrades if permissions are missing - logs helpful warnings but
 * doesn't fail the action. Requires `checks: write` permission.
 *
 * @param {string} name - Name of the check (default: 'Filecoin Upload')
 * @returns {Promise<number | null>} Check run ID or null if not in PR context or creation failed
 */
export async function createCheck(name = 'Filecoin Upload') {
  try {
    // Check if check run was already created by early action step
    const existingCheckId = process.env.FILECOIN_CHECK_RUN_ID
    const existingSha = process.env.FILECOIN_CHECK_SHA

    if (existingCheckId && existingSha) {
      console.log(`✓ Using existing check run (ID: ${existingCheckId})`)

      // Initialize minimal checkContext with existing check
      const { token, owner, repo } = getGitHubEnv()
      if (token && owner && repo) {
        const octokit = createOctokit(token)
        if (octokit) {
          checkContext = {
            octokit,
            owner,
            repo,
            sha: existingSha,
            checkRunId: Number.parseInt(existingCheckId, 10),
          }
          return checkContext.checkRunId
        }
      }
    }

    // Otherwise create a new check run
    checkContext = await initializeCheckContext()
    if (!checkContext) {
      return null
    }

    const { octokit, owner, repo, sha } = checkContext

    const response = await octokit.rest.checks.create({
      owner,
      repo,
      name,
      head_sha: sha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      output: {
        title: 'Building and uploading to Filecoin',
        summary: 'Creating CAR file and preparing for upload...',
      },
    })

    checkContext.checkRunId = response.data.id
    console.log(`✓ Created check run: ${name} (ID: ${response.data.id})`)

    return response.data.id
  } catch (error) {
    console.warn('Failed to create check run:', getErrorMessage(error))
    console.warn('Check status will not be visible in PR. Ensure workflow has `checks: write` permission.')
    return null
  }
}

/**
 * Update the check run with new status during build/upload progress.
 *
 * Silently no-ops if check creation failed (graceful degradation).
 * Updates the existing check run with new progress information.
 *
 * @param {Object} options
 * @param {string} options.title - Title for the output
 * @param {string} options.summary - Summary text
 * @param {string} [options.text] - Optional detailed text
 * @param {'in_progress' | 'queued' | 'completed'} [options.status] - Check status (default: 'in_progress')
 */
export async function updateCheck({ title, summary, text, status = 'in_progress' }) {
  if (!checkContext?.checkRunId || !checkContext.octokit) {
    return
  }

  try {
    const { octokit, owner, repo, checkRunId } = checkContext

    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status,
      output: {
        title,
        summary,
        ...(text && { text }),
      },
    })
  } catch (error) {
    console.warn('Failed to update check run:', getErrorMessage(error))
  }
}

/**
 * Complete the check run with final status (success/failure/skipped).
 *
 * Marks the check run as completed and sets the final conclusion that appears
 * in the PR checks UI. Silently no-ops if check creation failed.
 *
 * @param {Object} options
 * @param {'success' | 'failure' | 'cancelled' | 'skipped'} options.conclusion - Final conclusion
 * @param {string} options.title - Title for the output
 * @param {string} options.summary - Summary text
 * @param {string} [options.text] - Optional detailed text (typically full upload summary)
 */
export async function completeCheck({ conclusion, title, summary, text }) {
  if (!checkContext?.checkRunId || !checkContext.octokit) {
    return
  }

  try {
    const { octokit, owner, repo, checkRunId } = checkContext

    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title,
        summary,
        ...(text && { text }),
      },
    })

    console.log(`✓ Completed check run with conclusion: ${conclusion}`)
  } catch (error) {
    console.warn('Failed to complete check run:', getErrorMessage(error))
  }
}
