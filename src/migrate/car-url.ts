/**
 * Canonical trustless-CAR URL shape and the gateways trusted to serve it.
 *
 * This is the one definition of how a CID maps to a byte-reproducible CAR URL.
 * The migrate runner computes a piece commitment over exactly these bytes, so
 * anything that fetches CAR bytes for a piece commitment must build the URL
 * from here, never reimplement it: a second copy of this template that drifts
 * would break the byte-for-byte guarantee silently.
 */

/**
 * Gateways verified to serve deterministic, spec-compliant trustless CARs:
 * byte-identical to the canonical dfs/dups=n serialization of the DAG, which
 * the piece commitment depends on. Other gateways work via explicit
 * `--gateway`; admission here requires the byte-identity check
 * (`piece-cid-byte-identity` regression test pins it for this list).
 */
export const DEFAULT_GATEWAYS = ['https://trustless-gateway.link']

export const CAR_ACCEPT = 'application/vnd.ipld.car'

export const RAW_ACCEPT = 'application/vnd.ipld.raw'

/**
 * Build the trustless-gateway raw-block URL for a CID: the per-block
 * counterpart of {@link buildCarUrl}, used when a single block is fetched
 * outside a CAR stream (gap fill, retries).
 */
export function buildRawBlockUrl(gateway: string, cid: string): string {
  const base = gateway.replace(/\/+$/, '')
  return `${base}/ipfs/${cid}?format=raw`
}

/**
 * Build the canonical trustless-CAR URL for a CID. The query string pins every
 * variable the trustless-gateway spec exposes so byte output is reproducible
 * across fetches and gateways: full DAG scope, CAR v1 framing, depth-first
 * traversal order, no duplicate blocks. Without these, gateway defaults vary
 * (some emit CAR v2; some accept dup blocks), and the recomputed PieceCID will
 * diverge between the local commP pass and a later re-fetch.
 */
export function buildCarUrl(gateway: string, cid: string): string {
  const base = gateway.replace(/\/+$/, '')
  return `${base}/ipfs/${cid}?format=car&dag-scope=all&car-version=1&car-order=dfs&car-dups=n`
}
