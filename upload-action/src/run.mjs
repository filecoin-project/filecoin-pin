import * as core from '@actions/core'
import { configureTelemetry, flushTelemetry } from 'filecoin-pin/core/telemetry'
import { checkForUpdate } from 'filecoin-pin/version-check'

import { runBuild } from './build.js'
import { getErrorMessage, handleError } from './errors.js'
import { completeCheck, createCheck } from './github.js'
import { getInput, parseBoolean } from './inputs.js'
import { getOutputSummary } from './outputs.js'
import { runUpload } from './upload.js'

configureTelemetry({
  affordance: 'GitHub Action',
  disabled: parseBoolean(getInput('disableTelemetry', 'false')),
})

async function maybeNotifyAboutUpdates() {
  try {
    const result = await checkForUpdate()
    if (result.status === 'update-available') {
      core.notice(
        `New filecoin-pin version available (${result.currentVersion} → ${result.latestVersion}). ` +
          'Update your workflow to use the latest release: https://github.com/filecoin-project/filecoin-pin/releases'
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    core.debug(`Update check failed: ${message}`)
  }
}

async function main() {
  // Check for updates in the background.
  void maybeNotifyAboutUpdates()
  // Create/reuse check run (may already exist from early action step for fast UI feedback)
  await createCheck('Filecoin Upload')

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
}

main()
  .then(async () => {
    // Real uploads can leave SDK/network handles open after all action work is done.
    // Exit explicitly so GitHub Actions can run post-action cleanup steps.
    try {
      await flushTelemetry()
    } catch (err) {
      core.warning(`Telemetry flush failed: ${getErrorMessage(err)}`)
    } finally {
      process.exit(0)
    }
  })
  .catch(async (err) => {
    // Complete check with failure
    await completeCheck({
      conclusion: 'failure',
      title: '✗ Upload Failed',
      summary: `Error: ${getErrorMessage(err)}`,
    })

    handleError(err)
    try {
      await flushTelemetry()
    } catch (telemetryErr) {
      core.warning(`Telemetry flush failed: ${getErrorMessage(telemetryErr)}`)
    } finally {
      process.exit(1)
    }
  })
