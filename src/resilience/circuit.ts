import type { BatchVerifier, Verification, Verifier, VerifyClaimInput } from "../types.js";
import { isTransientError } from "./retry.js";

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  readonly code = "PROVIDER_CIRCUIT_OPEN" as const;
  constructor() {
    super("Provider circuit is open; no request was sent");
    this.name = "CircuitOpenError";
  }
}
export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
  isTransient?: (error: unknown) => boolean;
  onStateChange?: (state: CircuitState) => void;
}
/** Call counts are per verifier operation, not underlying HTTP attempts. */
export class CircuitBreakerVerifier implements BatchVerifier {
  readonly stats = { transientFailures: 0, opened: 0, blocked: 0, probes: 0 };
  private stateValue: CircuitState = "closed";
  private openedAt = 0;
  private consecutiveFailures = 0;
  private probeInFlight = false;
  private readonly threshold: number;
  private readonly cooldown: number;
  private readonly now: () => number;
  private readonly transient: (error: unknown) => boolean;

  constructor(private readonly delegate: Verifier, private readonly options: CircuitBreakerOptions = {}) {
    this.threshold = options.failureThreshold ?? 3;
    this.cooldown = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.transient = options.isTransient ?? isTransientError;
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 1) {
      throw new RangeError("failureThreshold must be a positive safe integer");
    }
    if (!Number.isFinite(this.cooldown) || this.cooldown < 0) {
      throw new RangeError("cooldownMs must be nonnegative and finite");
    }
  }

  get state(): CircuitState {
    return this.stateValue;
  }

  private transition(next: CircuitState): void {
    if (next === this.stateValue) return;
    this.stateValue = next;
    // Instrumentation cannot corrupt circuit state or introduce provider errors.
    try { this.options.onStateChange?.(next); } catch { /* ignore diagnostics */ }
  }
  private open(): void {
    this.openedAt = this.now();
    this.probeInFlight = false;
    this.consecutiveFailures = 0;
    this.stats.opened++;
    this.transition("open");
  }
  private enter(): boolean {
    if (this.stateValue === "open") {
      if (this.now() - this.openedAt < this.cooldown) {
        this.stats.blocked++;
        throw new CircuitOpenError();
      }
      this.transition("half-open");
    }
    if (this.stateValue === "half-open") {
      if (this.probeInFlight) {
        this.stats.blocked++;
        throw new CircuitOpenError();
      }
      this.probeInFlight = true;
      this.stats.probes++;
      return true;
    }
    return false;
  }

  private async perform<T>(operation: () => Promise<T>): Promise<T> {
    const probe = this.enter();
    try {
      const result = await operation();
      if (probe) {
        this.probeInFlight = false;
        this.transition("closed");
      }
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      if (probe) this.probeInFlight = false;
      if (this.transient(error)) {
        this.stats.transientFailures++;
        if (probe || ++this.consecutiveFailures >= this.threshold) this.open();
      } else if (probe) {
        // A permanent/schema failure is not evidence that transport is down.
        // A budget exception does not establish recovery either.
        if ((error as {code?: string})?.code === "PROVIDER_BUDGET_EXHAUSTED") {
          this.open();
        } else {
          this.consecutiveFailures = 0;
          this.transition("closed");
        }
      } else {
        this.consecutiveFailures = 0;
      }
      throw error;
    }
  }

  verify(input: VerifyClaimInput): Promise<Verification> {
    return this.perform(() => this.delegate.verify(input));
  }

  verifyMany(inputs: VerifyClaimInput[]): Promise<Verification[]> {
    if (!inputs.length) return Promise.resolve([]);
    const batch = (this.delegate as Partial<BatchVerifier>).verifyMany;
    if (typeof batch === "function") {
      return this.perform(() => batch.call(this.delegate, inputs));
    }
    return Promise.all(inputs.map(input => this.verify(input)));
  }
}
