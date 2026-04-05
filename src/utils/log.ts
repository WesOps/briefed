/**
 * Lightweight logging utilities.
 * Debug messages are only shown when BRIEFED_DEBUG=1 is set.
 * Warnings always go to stderr so they don't pollute stdout.
 */

const isDebug = process.env.BRIEFED_DEBUG === "1";

export function debug(msg: string): void {
  if (isDebug) {
    process.stderr.write(`[briefed:debug] ${msg}\n`);
  }
}

export function warn(msg: string): void {
  process.stderr.write(`[briefed:warn] ${msg}\n`);
}
