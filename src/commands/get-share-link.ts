import { Command } from 'commander'
import { type GetShareLinkOptions, runGetShareLink } from '../share/get-share-link.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const getShareLinkCommand = new Command('get-share-link')
  .description('Create a Share link for one encrypted upload, for someone without a wallet')
  .argument('<cid>', 'Encrypted root CID, as `add --encrypt` printed it')
  .option('--restricted', 'Keep the Access key out of the link: the recipient also needs it, sent separately')
  .option('--viewer <url>', 'Web page the link opens in')
  .option(
    '--piece <piece-cid>',
    "A private upload's piece CID, to skip finding it by the root CID. A private upload's link also carries the right to fetch it"
  )
  .addHelpText(
    'after',
    `
By default the link carries its own key: anyone with the link can open the upload. With
--restricted, the link and an Access key (fak1_…) are printed: send them by different channels.
Each link has its own key, so links are independent. A link shares this one upload, never the
rest of its group key, and it never expires.

A private upload (add --private) is served only on the authenticated path, so its link also
carries a claim that lets the link's key fetch it, and the providers that hold it. Pass its piece
CID with --piece. The link stops opening when that claim expires: with a session key, when its
Grant does (the Grant must allow delegation: not --delegation-depth 0); with the owner wallet, after
30 days.

Shares with the owner wallet (PRIVATE_KEY), or with a session key and its group key Grant (from
\`filecoin-pin login\`). The envelope header is read from the first blocks, verified against the CID.`
  )

addAuthOptions(getShareLinkCommand)

getShareLinkCommand.action(async (cid: string, options: GetShareLinkOptions) => {
  try {
    await runGetShareLink(cid, options)
  } catch {
    process.exit(1)
  }
})
