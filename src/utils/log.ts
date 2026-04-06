/**
 * Lightweight logging utilities.
 * Debug messages are only shown when BRIEFED_DEBUG=1 is set.
 */

const isDebug = process.env.BRIEFED_DEBUG === "1";

export function debug(msg: string): void {
  if (isDebug) {
    process.stderr.write(`[briefed:debug] ${msg}\n`);
  }
}
