/**
 * Migrate-specific input parsing. Generic flag parsers (sizes, positive
 * integers) live in `src/utils/cli-helpers.ts`; output goes through
 * `src/utils/cli-logger.ts` like every other command.
 */

/** Read a CID list file: one CID per line, blank lines and `#` comments ignored. */
export function parseCidList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}
