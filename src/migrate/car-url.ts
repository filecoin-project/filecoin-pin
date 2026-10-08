/**
 * Trustless-gateway CAR URL construction and the default gateway list. One
 * definition, so every fetch in the pipeline requests the same shape.
 */

/** Gateways used when no `--gateway` is given. */
export const DEFAULT_GATEWAYS = ['https://trustless-gateway.link']

export const CAR_ACCEPT = 'application/vnd.ipld.car'

/**
 * Build the trustless-gateway CAR URL for a CID. The query string pins the
 * variables the trustless-gateway spec exposes (full DAG scope, CAR v1
 * framing, depth-first order, no duplicate blocks) so responses stay
 * consistent across gateways; every block is still hash-verified and the DAG
 * completeness-checked before the bytes count as migrated.
 */
export function buildCarUrl(gateway: string, cid: string): string {
  const base = gateway.replace(/\/+$/, '')
  return `${base}/ipfs/${cid}?format=car&dag-scope=all&car-version=1&car-order=dfs&car-dups=n`
}
