import { runBuild } from './build.js'
import { getErrorMessage, handleError } from './errors.js'
import { cleanupSynapse } from './filecoin.js'
import { completeCheck, createCheck } from './github.js'
import { getOutputSummary } from './outputs.js'
import { runUpload } from './upload.js'

async function main() {
  // Create/reuse check run (may already exist from early action step for fast UI feedback)
  await createCheck('Filecoin Upload')

  try {
    const buildContext = await runBuild()
    const uploadContext = await runUpload(buildContext)

    // Handle fork PR case - skipped but not failed
    if (uploadContext.uploadStatus === 'fork-pr-blocked') {
      await completeCheck({
        conclusion: 'skipped',
        title: 'Fork PR Upload Blocked',
        summary: 'Fork PR support is currently disabled for security reasons',
        text: getOutputSummary(uploadContext, 'Fork PR blocked'),
      })
      return
    }

    // Handle dry run case
    if (uploadContext.uploadStatus === 'dry-run') {
      await completeCheck({
        conclusion: 'success',
        title: '✓ Dry Run Complete',
        summary: 'Dry run completed - no actual upload performed',
        text: getOutputSummary(uploadContext, 'Dry Run'),
      })
      return
    }

    // Complete check with success
    await completeCheck({
      conclusion: 'success',
      title: '✓ Upload Complete',
      summary: 'Successfully uploaded to Filecoin',
      text: getOutputSummary(uploadContext, 'Uploaded'),
    })
  } catch (error) {
    try {
      await cleanupSynapse()
    } catch (e) {
      console.error('Cleanup failed:', getErrorMessage(e))
    }
    throw error
  }
}

main().catch(async (err) => {
  // Complete check with failure
  await completeCheck({
    conclusion: 'failure',
    title: '✗ Upload Failed',
    summary: `Error: ${getErrorMessage(err)}`,
  })

  handleError(err)
  try {
    await cleanupSynapse()
  } catch (e) {
    console.error('Cleanup failed:', getErrorMessage(e))
  }
  process.exit(1)
})
