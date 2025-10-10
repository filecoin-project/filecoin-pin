import { runBuild } from './build.js'
import { getErrorMessage, handleError } from './errors.js'
import { cleanupSynapse } from './filecoin.js'
import { runUpload } from './upload.js'

async function main() {
  try {
    const buildContext = await runBuild()
    await runUpload(buildContext)
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
  handleError(err)
  try {
    await cleanupSynapse()
  } catch (e) {
    console.error('Cleanup failed:', getErrorMessage(e))
  }
  process.exit(1)
})
