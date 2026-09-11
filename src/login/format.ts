/** Display helpers shared by the login commands. */

/** `0x5929…c41a`: the first four and last four hex digits. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** `2026-09-26` from unix seconds. */
export function formatExpiryDate(epochSeconds: bigint): string {
  return new Date(Number(epochSeconds) * 1000).toISOString().slice(0, 10)
}

/** `4:37` from milliseconds remaining. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
