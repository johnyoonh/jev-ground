import type { Verification, Verifier, VerifyClaimInput } from "../types.js";

/**
 * Metadata specifying pricing rates for calculating estimated and actual USD costs.
 */
export interface PricingMetadata {
  /** Price per 1,000 prompt (input) tokens in USD. */
  promptTokenPricePer1k: number;
  /** Price per 1,000 completion (output) tokens in USD. Defaults to 0. */
  completionTokenPricePer1k?: number;
  /** Fixed cost per API call in USD. Defaults to 0. */
  fixedCostPerCall?: number;
  /** Currency identifier (e.g. "USD"). Defaults to "USD". */
  currency?: string;
}

/**
 * Options for initializing a run-level budget controller.
 *
 * NOTE: Local token and cost estimates cannot guarantee provider-side billing caps.
 * Always configure hard spending limits directly in your provider account settings.
 */
export interface RunBudgetOptions {
  /** Maximum total provider call attempts (inclusive of retries) allowed for the run. */
  maxAttempts?: number;
  /** Maximum concurrent in-flight requests permitted. */
  maxInFlight?: number;
  /** Maximum total prompt tokens allowed across the entire run. */
  maxPromptTokens?: number;
  /** Maximum total estimated USD cost allowed across the entire run. */
  maxEstimatedCostUsd?: number;
  /** Wall-clock timeout in milliseconds for the overall run execution. */
  timeoutMs?: number;
  /**
   * Explicit opt-in for paid provider calls.
   * Defaults to false. When false (or omitted), live calls are blocked with a dry-run result error.
   */
  paidCallsAllowed?: boolean;
  /** Pricing metadata pinned to the run budget and results. */
  pricing?: PricingMetadata;
  /** Custom clock function returning current epoch ms (for testing). */
  now?: () => number;
}

export type BudgetExhaustionReason =
  | "maxAttempts"
  | "maxPromptTokens"
  | "maxEstimatedCostUsd"
  | "timeout"
  | "paidCallsDisabled";

export interface RunBudgetStats {
  actualAttempts: number;
  actualPromptTokens: number;
  actualCompletionTokens: number;
  actualCostUsd: number;
  estimatedAttempts: number;
  estimatedPromptTokens: number;
  estimatedCostUsd: number;
  peakInFlight: number;
  exhaustedReason?: BudgetExhaustionReason;
  pricing?: PricingMetadata;
}

export class BudgetExhaustedError extends Error {
  readonly reason: BudgetExhaustionReason;
  readonly stats: RunBudgetStats;

  constructor(message: string, reason: BudgetExhaustionReason, stats: RunBudgetStats) {
    super(message);
    this.name = "BudgetExhaustedError";
    this.reason = reason;
    this.stats = stats;
  }
}

export interface Reservation {
  release(actualUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    failed?: boolean;
  }): void;
}

export function defaultEstimateTokens(input: VerifyClaimInput): number {
  const claimChars = input.claim.length;
  const evidenceChars = input.evidence.reduce((acc, e) => acc + e.text.length, 0);
  return Math.ceil((claimChars + evidenceChars) / 4);
}

/**
 * Centralized per-run budget controller.
 * Manages attempts, concurrency limits, prompt tokens, estimated costs, and run wall-clock timeout.
 */
export class RunBudgetController {
  private readonly startTime: number;
  private readonly now: () => number;
  private inFlight = 0;
  private peakInFlight = 0;
  private actualAttempts = 0;
  private actualPromptTokens = 0;
  private actualCompletionTokens = 0;
  private actualCostUsd = 0;
  private estimatedAttempts = 0;
  private estimatedPromptTokens = 0;
  private estimatedCostUsd = 0;
  private reservedAttempts = 0;
  private reservedPromptTokens = 0;
  private reservedCostUsd = 0;
  private exhaustedReason?: BudgetExhaustionReason;

  private readonly waitQueue: Array<() => void> = [];

  constructor(private readonly options: RunBudgetOptions = {}) {
    this.now = options.now ?? Date.now;
    this.startTime = this.now();
  }

  calculateCost(promptTokens: number, completionTokens: number = 0, isCall: boolean = true): number {
    if (!this.options.pricing) return 0;
    const { promptTokenPricePer1k, completionTokenPricePer1k = 0, fixedCostPerCall = 0 } = this.options.pricing;
    const promptCost = (promptTokens / 1000) * promptTokenPricePer1k;
    const completionCost = (completionTokens / 1000) * completionTokenPricePer1k;
    const callCost = isCall ? fixedCostPerCall : 0;
    return promptCost + completionCost + callCost;
  }

  getStats(): RunBudgetStats {
    return {
      actualAttempts: this.actualAttempts,
      actualPromptTokens: this.actualPromptTokens,
      actualCompletionTokens: this.actualCompletionTokens,
      actualCostUsd: this.actualCostUsd,
      estimatedAttempts: this.estimatedAttempts,
      estimatedPromptTokens: this.estimatedPromptTokens,
      estimatedCostUsd: this.estimatedCostUsd,
      peakInFlight: this.peakInFlight,
      exhaustedReason: this.exhaustedReason,
      pricing: this.options.pricing ? { ...this.options.pricing } : undefined,
    };
  }

  async reserveCall(estimatedPromptTokens: number = 0): Promise<Reservation> {
    // Enforce maxInFlight concurrency limit via waiting queue
    if (this.options.maxInFlight !== undefined && this.options.maxInFlight > 0) {
      while (this.inFlight >= this.options.maxInFlight) {
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onSlot = () => {
            if (timer) clearTimeout(timer);
            resolve();
          };
          this.waitQueue.push(onSlot);

          if (this.options.timeoutMs) {
            const elapsed = this.now() - this.startTime;
            const remaining = this.options.timeoutMs - elapsed;
            if (remaining <= 0) {
              const idx = this.waitQueue.indexOf(onSlot);
              if (idx !== -1) this.waitQueue.splice(idx, 1);
              this.exhaustedReason = "timeout";
              reject(new BudgetExhaustedError("Run wall-clock timeout exceeded while waiting for concurrency slot", "timeout", this.getStats()));
              return;
            }
            timer = setTimeout(() => {
              const idx = this.waitQueue.indexOf(onSlot);
              if (idx !== -1) this.waitQueue.splice(idx, 1);
              this.exhaustedReason = "timeout";
              reject(new BudgetExhaustedError("Run wall-clock timeout exceeded while waiting for concurrency slot", "timeout", this.getStats()));
            }, remaining);
          }
        });
      }
    }

    // Enforce overall wall-clock run timeout
    if (this.options.timeoutMs !== undefined && this.now() - this.startTime >= this.options.timeoutMs) {
      this.exhaustedReason = "timeout";
      throw new BudgetExhaustedError("Run wall-clock timeout exceeded", "timeout", this.getStats());
    }

    // Require explicit paid call opt-in (default: false for dry-run protection)
    if (!this.options.paidCallsAllowed) {
      this.estimatedAttempts++;
      this.estimatedPromptTokens += estimatedPromptTokens;
      const estCost = this.calculateCost(estimatedPromptTokens, 0, true);
      this.estimatedCostUsd += estCost;
      this.exhaustedReason = "paidCallsDisabled";
      throw new BudgetExhaustedError("Paid provider calls not allowed (dry-run mode). Set paidCallsAllowed: true to enable live requests.", "paidCallsDisabled", this.getStats());
    }

    // Enforce maxAttempts
    const estAttemptNumber = this.actualAttempts + this.reservedAttempts + 1;
    if (this.options.maxAttempts !== undefined && estAttemptNumber > this.options.maxAttempts) {
      this.exhaustedReason = "maxAttempts";
      throw new BudgetExhaustedError(`Max attempts limit reached (${this.options.maxAttempts})`, "maxAttempts", this.getStats());
    }

    // Enforce maxPromptTokens
    const estPromptTokensTotal = this.actualPromptTokens + this.reservedPromptTokens + estimatedPromptTokens;
    if (this.options.maxPromptTokens !== undefined && estPromptTokensTotal > this.options.maxPromptTokens) {
      this.exhaustedReason = "maxPromptTokens";
      throw new BudgetExhaustedError(`Max prompt tokens limit reached (${this.options.maxPromptTokens})`, "maxPromptTokens", this.getStats());
    }

    // Enforce maxEstimatedCostUsd
    const callEstCost = this.calculateCost(estimatedPromptTokens, 0, true);
    const estTotalCost = this.actualCostUsd + this.reservedCostUsd + callEstCost;
    if (this.options.maxEstimatedCostUsd !== undefined && estTotalCost > this.options.maxEstimatedCostUsd) {
      this.exhaustedReason = "maxEstimatedCostUsd";
      throw new BudgetExhaustedError(`Max estimated USD cost reached (${this.options.maxEstimatedCostUsd})`, "maxEstimatedCostUsd", this.getStats());
    }

    // Reserve allowance
    this.inFlight++;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
    this.reservedAttempts++;
    this.reservedPromptTokens += estimatedPromptTokens;
    this.reservedCostUsd += callEstCost;
    this.estimatedAttempts++;
    this.estimatedPromptTokens += estimatedPromptTokens;
    this.estimatedCostUsd += callEstCost;

    let released = false;

    return {
      release: (actualUsage) => {
        if (released) return;
        released = true;

        this.inFlight--;
        this.reservedAttempts--;
        this.reservedPromptTokens -= estimatedPromptTokens;
        this.reservedCostUsd -= callEstCost;

        this.actualAttempts++;
        const actualPrompt = actualUsage?.promptTokens ?? estimatedPromptTokens;
        const actualCompletion = actualUsage?.completionTokens ?? 0;
        this.actualPromptTokens += actualPrompt;
        this.actualCompletionTokens += actualCompletion;
        const actualCallCost = this.calculateCost(actualPrompt, actualCompletion, true);
        this.actualCostUsd += actualCallCost;

        if (this.waitQueue.length > 0) {
          const next = this.waitQueue.shift();
          next?.();
        }
      },
    };
  }
}

export class BudgetedVerifier implements Verifier {
  constructor(
    private readonly delegate: Verifier,
    readonly budget: RunBudgetController,
    private readonly estimateTokens: (input: VerifyClaimInput) => number = defaultEstimateTokens,
  ) {}

  async verify(input: VerifyClaimInput): Promise<Verification> {
    const estTokens = this.estimateTokens(input);
    const reservation = await this.budget.reserveCall(estTokens);
    try {
      const result = await this.delegate.verify(input);
      const actualPrompt = extractPromptTokens(result.raw) ?? estTokens;
      const actualCompletion = extractCompletionTokens(result.raw) ?? 0;
      reservation.release({ promptTokens: actualPrompt, completionTokens: actualCompletion });
      return result;
    } catch (error) {
      reservation.release({ promptTokens: estTokens, completionTokens: 0, failed: true });
      throw error;
    }
  }
}

function extractPromptTokens(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const usage = (r.usage ?? r.tokenUsage) as Record<string, unknown> | undefined;
  const prompt = usage?.prompt_tokens ?? usage?.promptTokens ?? r.prompt_tokens ?? r.promptTokens;
  return typeof prompt === "number" && Number.isFinite(prompt) ? prompt : undefined;
}

function extractCompletionTokens(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const usage = (r.usage ?? r.tokenUsage) as Record<string, unknown> | undefined;
  const completion = usage?.completion_tokens ?? usage?.completionTokens ?? r.completion_tokens ?? r.completionTokens;
  return typeof completion === "number" && Number.isFinite(completion) ? completion : undefined;
}
