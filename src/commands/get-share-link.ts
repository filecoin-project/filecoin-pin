import { Command } from 'commander'
import { type GetShareLinkOptions, runGetShareLink } from '../share/get-share-link.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const getShareLinkCommand = new Command('get-share-link')
  .description('Create a Share link for one encrypted upload, for someone without a wallet')
  .argument('<cid>', 'Encrypted root CID of an upload made with `add --encrypt`')
  .option('--restricted', 'Keep the Access key out of the link: the recipient also needs it, sent separately')
  .option('--viewer <url>', 'Web page the link opens in')
  .addHelpText(
    'after',
    `
By default the link carries its own key: anyone with the link can open the upload. With
--restricted, the link and an Access key (fak1_…) are printed: send them by different channels.
Each link has its own key, so links are independent. A link shares this one upload, never the
rest of its group key, and it never expires.

Shares with the owner wallet (PRIVATE_KEY), or with a session key and its group key Grant (from
\`filecoin-pin login\`). The upload's header is read from its first blocks, verified against the CID.`
  )

addAuthOptions(getShareLinkCommand)

getShareLinkCommand.action(async (cid: string, options: GetShareLinkOptions) => {
  try {
    await runGetShareLink(cid, options)
  } catch {
    process.exit(1)
  }
})
