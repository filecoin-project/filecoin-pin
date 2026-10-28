import { Command } from 'commander'
import { DEFAULT_SHARE_DAYS, type GetShareLinkOptions, runGetShareLink } from '../share/get-share-link.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const getShareLinkCommand = new Command('get-share-link')
  .description('Create a Share link for one encrypted upload, for someone without a wallet')
  .argument('<cid>', 'Encrypted root CID of an upload made with `add --encrypt`')
  .option('--password [password]', 'Open with a password instead of an Access key (generated when not given)')
  .option('--restricted', 'Put the Access key inside the link: the link alone opens the upload')
  .option(
    '--expires <days>',
    `Owner wallet only: days the link can fetch from gating providers (default: ${DEFAULT_SHARE_DAYS})`
  )
  .option('--viewer <url>', 'Web page the link opens in')
  .addHelpText(
    'after',
    `
By default the link and an Access key (fak1_…) are printed: send them by different channels.
Each link has its own key, so links are independent. A link shares this one upload, never the
rest of its group key, and decrypting it never expires.

Shares with the owner wallet (PRIVATE_KEY), or with a session key and its group key Grant (from
\`filecoin-pin login\`). The upload's header is read from this machine's record of its uploads,
else from the upload's first blocks, verified against the CID.`
  )

addAuthOptions(getShareLinkCommand)

getShareLinkCommand.action(async (cid: string, options: GetShareLinkOptions) => {
  try {
    await runGetShareLink(cid, options)
  } catch {
    process.exit(1)
  }
})
