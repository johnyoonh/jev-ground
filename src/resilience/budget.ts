/**
 * Per-run synchronous reservation of provider request attempts. A reservation
 * must happen immediately before each HTTP/SDK request; retry wrappers and
 * concurrency cannot bypass this gate.
 */
export type ProviderBudgetReason =
  | "requests"
  | "estimated_tokens"
  | "estimated_cost"
  | "deadline";

export class ProviderBudgetExceededError extends Error {
  readonly code = "PROVIDER_BUDGET_EXHAUSTED" as const;
  constructor(readonly reason: ProviderBudgetReason) {
    super("Provider request budget exhausted: " + reason);
    this.name = "ProviderBudgetExceededError";
  }
}

export interface ProviderBudgetOptions {
  /** Actual request attempts, including retries and multi-chunk batches. */
  maxRequests: number;
  /** Estimates are not authoritative billing measurements. */
  maxEstimatedTokens?: number;
  maxEstimatedCostUsd?: number;
  /** Run deadline measured from budget construction, in milliseconds. */
  maxWallClockMs?: number;
  now?: () => number;
}
export interface ProviderReservation {
  /** Estimated input+output budget. Required if maxEstimatedTokens is enabled. */
  estimatedTokens?: number;
  /** Estimated USD budget. Required if maxEstimatedCostUsd is enabled. */
  estimatedCostUsd?: number;
}
export interface ProviderBudgetSnapshot {
  maxRequests: number;
  requestsReserved: number;
  requestsRemaining: number;
  estimatedTokensReserved: number;
  estimatedCostUsdReserved: number;
  exhausted: boolean;
  exhaustedReason?: ProviderBudgetReason;
}

function assertNonnegativeFinite(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(name + " must be a nonnegative finite number");
  }
}
export class ProviderCallBudget {
  private requests = 0;
  private estimatedTokens = 0;
  private estimatedCostUsd = 0;
  private exhaustedReason?: ProviderBudgetReason;
  private readonly now: () => number;
  private readonly startMs: number;

  constructor(readonly options: ProviderBudgetOptions) {
    if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1) {
      throw new RangeError("maxRequests must be a positive safe integer");
    }
    assertNonnegativeFinite(options.maxEstimatedTokens, "maxEstimatedTokens");
    assertNonnegativeFinite(options.maxEstimatedCostUsd, "maxEstimatedCostUsd");
    assertNonnegativeFinite(options.maxWallClockMs, "maxWallClockMs");
    this.now = options.now ?? Date.now;
    this.startMs = this.now();
  }

  /**
   * Synchronous atomic reservation; no async gap exists between checking and
   * incrementing. Failed provider requests consume attempts; cache hits do not.
   */
  reserve(estimate: ProviderReservation = {}): void {
    if (this.exhaustedReason) throw new ProviderBudgetExceededError(this.exhaustedReason);
    const { maxEstimatedTokens, maxEstimatedCostUsd, maxWallClockMs } = this.options;
    const tokens = estimate.estimatedTokens;
    const cost = estimate.estimatedCostUsd;
    assertNonnegativeFinite(tokens, "estimatedTokens");
    assertNonnegativeFinite(cost, "estimatedCostUsd");
    if (maxEstimatedTokens !== undefined && tokens === undefined) {
      throw new TypeError("estimatedTokens required when maxEstimatedTokens is set");
    }
    if (maxEstimatedCostUsd !== undefined && cost === undefined) {
      throw new TypeError("estimatedCostUsd required when maxEstimatedCostUsd is set");
    }
    let reason: ProviderBudgetReason | undefined;
    if (maxWallClockMs !== undefined && this.now() - this.startMs >= maxWallClockMs) {
      reason = "deadline";
    } else if (this.requests >= this.options.maxRequests) {
      reason = "requests";
    } else if (maxEstimatedTokens !== undefined &&
        this.estimatedTokens + (tokens ?? 0) > maxEstimatedTokens) {
      reason = "estimated_tokens";
    } else if (maxEstimatedCostUsd !== undefined &&
        this.estimatedCostUsd + (cost ?? 0) > maxEstimatedCostUsd) {
      reason = "estimated_cost";
    }
    if (reason) {
      this.exhaustedReason = reason;
      throw new ProviderBudgetExceededError(reason);
    }
    this.requests++;
    this.estimatedTokens += tokens ?? 0;
    this.estimatedCostUsd += cost ?? 0;
  }

  get snapshot(): ProviderBudgetSnapshot {
    return {
      maxRequests: this.options.maxRequests,
      requestsReserved: this.requests,
      requestsRemaining: this.options.maxRequests - this.requests,
      estimatedTokensReserved: this.estimatedTokens,
      estimatedCostUsdReserved: this.estimatedCostUsd,
      exhausted: this.exhaustedReason !== undefined ||
        this.requests >= this.options.maxRequests,
      ...(this.exhaustedReason ? { exhaustedReason: this.exhaustedReason } : {}),
    };
  }
}
