import { readFile } from 'node:fs/promises'
import { Octokit } from '@octokit/rest'
import { getGlobalContext, mergeAndSaveContext } from './context.js'
import { getErrorMessage } from './errors.js'
import { getInput } from './inputs.js'

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
 * @returns {import('./types.js').CombinedContext['pr'] | undefined}
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
 * @returns {import('./types.js').CombinedContext['pr'] | undefined}
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
 * @returns {Promise<import('./types.js').CombinedContext['pr'] | undefined>}
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
 * Ensure PR metadata is available in global context, resolving it when triggered by workflow_run
 * @returns {Promise<import('./types.js').CombinedContext['pr'] | undefined>}
 */
export async function ensurePullRequestContext() {
  const ctx = getGlobalContext()
  if (ctx?.pr?.number) return ctx.pr

  const event = await readEventPayload()
  if (!event) return undefined

  let pr = normalizePr(event?.pull_request)

  if (!pr && event?.workflow_run) {
    pr = resolveFromWorkflowRunPayload(event.workflow_run)

    if (!pr) {
      const token = process.env.GITHUB_TOKEN || getInput('github_token') || ''
      const octokit = token ? new Octokit({ auth: token }) : undefined
      pr = await resolveFromWorkflowRunApi(octokit, event)
    }
  }

  if (pr) {
    const merged = mergeAndSaveContext({ pr })
    return merged.pr
  }

  return undefined
}
