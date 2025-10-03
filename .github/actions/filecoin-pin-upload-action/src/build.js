import pc from 'picocolors'
import pino from 'pino'
import { mergeAndSaveContext } from './context.js'
import { createCarFile } from './filecoin.js'
import { readEventPayload } from './github.js'
import { formatSize } from './outputs.js'

/**
 * @typedef {import('./types.js').CombinedContext} CombinedContext
 * @typedef {import('./types.js').ParsedInputs} ParsedInputs
 * @typedef {import('./types.js').BuildResult} BuildResult
 */

/**
 * Update context with PR and build context
 */
async function updateBuildContext() {
  const buildRunId = process.env.GITHUB_RUN_ID || ''
  const eventName = process.env.GITHUB_EVENT_NAME || ''
  const event = await readEventPayload()

  /** @type {Partial<CombinedContext>} */
  const payload = {
    buildRunId: buildRunId,
    eventName: eventName,
  }

  // Handle PR context
  if (event?.pull_request) {
    const pr = event.pull_request
    payload.pr = {
      number: typeof pr.number === 'number' ? pr.number : Number(pr.number) || 0,
      sha: pr?.head?.sha || '',
      title: pr?.title || '',
      author: pr?.user?.login || '',
    }
  }

  await mergeAndSaveContext(payload)
}

/**
 * Run build phase: Create CAR file and store in context
 */
export async function runBuild() {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

  console.log('━━━ Build Phase: Creating CAR file ━━━')

  // Check if this is a fork PR first
  const event = await readEventPayload()
  if (event?.pull_request) {
    const pr = event.pull_request
    const isForkPR = pr.head?.repo?.full_name !== pr.base?.repo?.full_name

    if (isForkPR) {
      console.log('━━━ Fork PR Detected - Building CAR but Blocking Upload ━━━')
      console.error('::error::Fork PR support is currently disabled. Only same-repo workflows are supported.')
      console.log('::notice::Building CAR file but upload will be blocked')
      // update the context with the upload status
      mergeAndSaveContext({
        uploadStatus: 'fork-pr-blocked',
      })
    }
  }

  const { parseInputs, resolveContentPath } = await import('./inputs.js')
  const inputs = /** @type {ParsedInputs} */ (parseInputs('compute'))
  const { contentPath } = inputs
  const targetPath = resolveContentPath(contentPath)

  // Create CAR file
  const buildResult = /** @type {BuildResult} */ (await createCarFile(targetPath, contentPath, logger))
  const { carPath, ipfsRootCid, carSize } = buildResult
  console.log(`IPFS Root CID: ${pc.bold(ipfsRootCid)}`)
  console.log(`::notice::IPFS Root CID: ${ipfsRootCid}`)

  if (carSize) {
    console.log(`CAR file size: ${pc.bold(formatSize(carSize))}`)
    console.log(`::notice::CAR file size: ${formatSize(carSize)}`)
  }

  // Update context with build context (PR info, etc.)
  await updateBuildContext()

  // Note: PR context is saved
  if (event?.pull_request?.number) {
    console.log(`::notice::PR #${event.pull_request.number} context saved`)
  }

  // Determine upload status based on whether this is a fork PR
  const isForkPR =
    event?.pull_request && event.pull_request.head?.repo?.full_name !== event.pull_request.base?.repo?.full_name
  const uploadStatus = isForkPR ? 'fork-pr-blocked' : 'pending-upload'

  // Update context with CID and CAR info
  await mergeAndSaveContext({
    ipfsRootCid: ipfsRootCid,
    carSize: carSize,
    carPath: carPath,
    uploadStatus: uploadStatus,
  })

  console.log('✓ Build complete. CAR file created and stored in context')
  console.log('::notice::Build phase complete. CAR file created.')
}
