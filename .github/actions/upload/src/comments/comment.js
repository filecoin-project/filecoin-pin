import { Octokit } from '@octokit/rest'
import { getErrorMessage } from '../errors.js'
import { getOutputSummary } from '../outputs.js'

/**
 * @typedef {import('../types.js').CommentPRParams} CommentPRParams
 * @typedef {import('../types.js').CombinedContext} CombinedContext
 */

/**
 * Generate comment body based on upload status
 * @param {CombinedContext} context
 * @param {string} status
 * @returns
 */
const generateCommentBody = (context, status) => {
  return `${getOutputSummary(context, status)}
  <a href="${getWorkflowRunUrl()}">More details</a>`
}

/**
 * Generate workflow run URL
 * @returns {string}
 */
function getWorkflowRunUrl() {
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const repository = process.env.GITHUB_REPOSITORY || ''
  const runId = process.env.GITHUB_RUN_ID || ''

  if (!repository || !runId) {
    return 'link to workflow run'
  }

  return `${serverUrl}/${repository}/actions/runs/${runId}`
}

/**
 * Comment on PR with Filecoin upload results
 * @param {CombinedContext} ctx
 */
export async function commentOnPR(ctx) {
  // Try to get PR number from parameter or context
  let { ipfsRootCid, dataSetId, pieceCid, pr, dryRun } = ctx
  const github_token = process.env.GITHUB_TOKEN || ''
  const github_repository = process.env.GITHUB_REPOSITORY || ''

  /** @type {number | undefined} */
  let resolvedPrNumber = pr?.number

  // Also try from GitHub event
  if (!resolvedPrNumber && process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const envPrNumber = process.env.GITHUB_EVENT_PULL_REQUEST_NUMBER
    resolvedPrNumber = envPrNumber ? parseInt(envPrNumber, 10) : undefined
  }

  if (!resolvedPrNumber) {
    console.log('Skipping PR comment: no PR number found (likely not a PR event)')
    return
  }

  if (dryRun) {
    console.log('Skipping PR comment: running in dry-run mode')
    return
  }

  // If this is a fork PR that was blocked, we need to comment with explanation
  if (ctx.pr && ctx.uploadStatus === 'fork-pr-blocked') {
    console.log('Posting comment for blocked fork PR')
    // Set dummy values so the comment function doesn't skip
    if (!ipfsRootCid) ipfsRootCid = 'N/A (fork PR blocked)'
    if (!dataSetId) dataSetId = 'N/A (fork PR blocked)'
    if (!pieceCid) pieceCid = 'N/A (fork PR blocked)'
  }

  if (!ipfsRootCid || !dataSetId || !pieceCid) {
    console.log('Skipping PR comment: missing required upload information')
    return
  }

  const contextForComment = {
    ...ctx,
    ipfsRootCid,
    dataSetId,
    pieceCid,
  }

  const summaryStatus = contextForComment.uploadStatus === 'fork-pr-blocked' ? 'Fork PR blocked' : 'Uploaded'

  const [owner, repo] = github_repository.split('/')
  const issue_number = resolvedPrNumber

  if (!owner || !repo) {
    console.error('Invalid repository format:', github_repository)
    return
  }

  const octokit = new Octokit({ auth: github_token })

  const body = generateCommentBody(contextForComment, summaryStatus)

  try {
    // Find existing comment
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number,
      per_page: 100,
    })

    const existing = comments.find(
      (c) => c.user?.type === 'Bot' && (c.body || '').includes('filecoin-pin-upload-action')
    )

    if (existing) {
      console.log(`Updating existing comment ${existing.id} on PR #${issue_number}`)
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      })
    } else {
      console.log(`Creating new comment on PR #${issue_number}`)
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number,
        body,
      })
    }

    console.log('PR comment posted successfully')
  } catch (error) {
    console.error('Failed to comment on PR:', getErrorMessage(error))
    process.exit(1)
  }
}
