/**
 * Cost tracking for the polybench harness. A single `CostTracker` is passed
 * through the orchestrator loop so the cap applies across all arms and tasks.
 * When the cap is exceeded we throw `CostCapExceededError`, which the
 * orchestrator catches at the outer arm loop to break cleanly and still emit
 * a partial report.
 */

export class CostCapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostCapExceededError";
  }
}

export class CostTracker {
  private _total = 0;

  add(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) {
      this._total += usd;
    }
  }

  get total(): number {
    return this._total;
  }

  /**
   * Throws `CostCapExceededError` if accumulated spend has passed the cap.
   * Call this immediately after `add()` in the orchestrator.
   */
  checkCap(capUsd: number): void {
    if (this._total > capUsd) {
      throw new CostCapExceededError(
        `Cost cap of $${capUsd.toFixed(2)} exceeded (spent $${this._total.toFixed(4)})`,
      );
    }
  }
}
