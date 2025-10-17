import { cancel, confirm } from '@clack/prompts'
import pc from 'picocolors'
import { log } from '../utils/cli-logger.js'

export async function warnAboutCDNPricingLimitations(): Promise<boolean> {
  log.warn(pc.red('CDN Pricing Notice'))
  log.newline()
  log.line('Filecoin-pin currently does not support CDN pricing in payment calculations.')
  log.newline()
  log.line('This means:')
  log.indent('• Deposit calculations may not be accurate for CDN storage')
  log.indent('• You may need additional USDFC deposits for CDN-enabled uploads')
  log.indent('• Filcdn is transitioning to egress-based billing (from fixed fees)')
  log.newline()
  log.flush()

  const shouldProceed = await confirm({
    message: 'Do you want to proceed with CDN-enabled upload?',
    initialValue: false,
  })

  if (shouldProceed === null) {
    cancel('Operation cancelled')
    process.exitCode = 1
  }

  return Boolean(shouldProceed)
}
