import { promises as fs } from 'node:fs'
import pc from 'picocolors'
import pino from 'pino'
import { createCarFile, readCarFile } from './filecoin.js'
import { readEventPayload, updateCheck } from './github.js'
import { parseInputs, resolveContentPath } from './inputs.js'
import { formatSize } from './outputs.js'

/**
 * @typedef {import('./types.js').CombinedContext} CombinedContext
 * @typedef {import('./types.js').ParsedInputs} ParsedInputs
 * @typedef {import('./types.js').BuildResult} BuildResult
 */

/**
 * Run build phase: Create CAR file and return build context details
 */
export async function runBuild() {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

  console.log('━━━ Build Phase: Creating CAR file ━━━')

  await updateCheck({
    title: 'Building CAR file',
    summary: 'Creating CAR file from content...',
  })

  const event = await readEventPayload()
  const buildRunId = process.env.GITHUB_RUN_ID || ''
  const eventName = process.env.GITHUB_EVENT_NAME || ''

  /** @type {CombinedContext['pr'] | undefined} */
  let pr
  if (event?.pull_request) {
    const pullRequest = event.pull_request
    pr = {
      number: typeof pullRequest.number === 'number' ? pullRequest.number : Number(pullRequest.number) || 0,
      sha: pullRequest?.head?.sha || '',
      title: pullRequest?.title || '',
      author: pullRequest?.user?.login || '',
    }
  }

  const isForkPR = Boolean(
    event?.pull_request && event.pull_request.head?.repo?.full_name !== event.pull_request.base?.repo?.full_name
  )

  if (isForkPR) {
    console.log('━━━ Fork PR Detected - Building CAR but Blocking Upload ━━━')
    console.error('::error::Fork PR support is currently disabled. Only same-repo workflows are supported.')
    console.log('::notice::Building CAR file but upload will be blocked')
  }

  const inputs = /** @type {ParsedInputs} */ (parseInputs('compute'))
  const { contentPath } = inputs
  const targetPath = resolveContentPath(contentPath)

  // If the user passed a path to an existing .car file, skip UnixFS packing
  // and upload the CAR as-is. Otherwise, pack the directory/file into a CAR.
  const buildResult = /** @type {BuildResult} */ (
    (await isPrebuiltCar(targetPath))
      ? await readCarFile(targetPath, contentPath, logger)
      : await createCarFile(targetPath, contentPath, logger)
  )
  const { carPath, ipfsRootCid, carSize } = buildResult
  console.log(`IPFS Root CID: ${pc.bold(ipfsRootCid)}`)
  console.log(`::notice::IPFS Root CID: ${ipfsRootCid}`)

  if (carSize) {
    console.log(`CAR file size: ${pc.bold(formatSize(carSize))}`)
    console.log(`::notice::CAR file size: ${formatSize(carSize)}`)
  }

  if (pr?.number) {
    console.log(`::notice::PR #${pr.number} context detected`)
  }

  /** @type {Partial<CombinedContext>} */
  const context = {
    ipfsRootCid,
    carSize,
    carPath,
    uploadStatus: isForkPR ? 'fork-pr-blocked' : 'pending-upload',
    contentPath,
    buildRunId,
    eventName,
  }

  if (pr) {
    context.pr = pr
  }

  console.log('✓ Build complete. CAR file created.')
  console.log('::notice::Build phase complete. CAR file created.')

  await updateCheck({
    title: 'CAR file built',
    summary: `Built CAR file for IPFS Root CID: \`${ipfsRootCid}\``,
    text: carSize ? `CAR file size: ${formatSize(carSize)}` : undefined,
  })

  return context
}

/**
 * A path is treated as a pre-built CAR when it points to a regular file
 * whose name ends in `.car`. Directories (even named `foo.car/`) fall
 * through to the UnixFS packer.
 *
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function isPrebuiltCar(targetPath) {
  if (!targetPath.toLowerCase().endsWith('.car')) return false
  try {
    const stats = await fs.stat(targetPath)
    return stats.isFile()
  } catch {
    return false
  }
}
