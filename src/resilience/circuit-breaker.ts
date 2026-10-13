import type { Verification, Verifier, VerifyClaimInput } from "../types.js";
import { isTransientError } from "./retry.js";

export type CircuitState = "closed" | "open" | "half-open";

/**
 * Configuration options for the circuit breaker controller.
 */
export interface CircuitBreakerOptions {
  /** Number of consecutive failures before the circuit opens. Defaults to 3. */
  failureThreshold?: number;
  /** Cooldown duration in milliseconds before shifting from OPEN to HALF-OPEN. Defaults to 10000. */
  cooldownMs?: number;
  /** Function determining whether an error triggers the circuit breaker. Defaults to transient API errors. */
  isFailure?: (error: unknown) => boolean;
  /** Custom clock returning current epoch ms. Defaults to Date.now. */
  now?: () => number;
  /** Listener notified when the circuit state changes. */
  onStateChange?: (fromState: CircuitState, toState: CircuitState) => void;
}

export class CircuitBreakerOpenError extends Error {
  readonly state: CircuitState;
  readonly cooldownRemainingMs: number;

  constructor(message: string, state: CircuitState, cooldownRemainingMs: number = 0) {
    super(message);
    this.name = "CircuitBreakerOpenError";
    this.state = state;
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}

/**
 * Controller implementing a 3-state circuit breaker (CLOSED, OPEN, HALF-OPEN) with
 * bounded single canary probe execution during HALF-OPEN state.
 */
export class CircuitBreakerController {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private openedAt = 0;
  private inFlightCanary = false;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly isFailure: (error: unknown) => boolean;
  private readonly now: () => number;
  private readonly onStateChange?: (fromState: CircuitState, toState: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 10000;
    this.isFailure = options.isFailure ?? isTransientError;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;

    if (!Number.isInteger(this.failureThreshold) || this.failureThreshold < 1) {
      throw new RangeError("failureThreshold must be an integer >= 1");
    }
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs < 0) {
      throw new RangeError("cooldownMs must be a non-negative number");
    }
  }

  getState(): CircuitState {
    this.updateState();
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  private updateState(): void {
    if (this.state === "open") {
      const elapsed = this.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.transitionTo("half-open");
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    if (newState === "open") {
      this.openedAt = this.now();
    } else if (newState === "closed") {
      this.failureCount = 0;
    }
    this.onStateChange?.(oldState, newState);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.updateState();

    if (this.state === "open") {
      const elapsed = this.now() - this.openedAt;
      const remaining = Math.max(0, this.cooldownMs - elapsed);
      throw new CircuitBreakerOpenError(
        `Backend circuit breaker is OPEN due to sustained provider failures/outage. Cooldown remaining: ${remaining}ms`,
        "open",
        remaining,
      );
    }

    if (this.state === "half-open") {
      if (this.inFlightCanary) {
        throw new CircuitBreakerOpenError(
          "Backend circuit breaker is HALF-OPEN (a single canary request is already in-flight)",
          "half-open",
          0,
        );
      }
      this.inFlightCanary = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    } finally {
      if (this.state === "half-open") {
        this.inFlightCanary = false;
      }
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.transitionTo("closed");
    } else if (this.state === "closed") {
      this.failureCount = 0;
    }
  }

  private onFailure(error: unknown): void {
    if (this.isFailure(error)) {
      if (this.state === "half-open") {
        this.transitionTo("open");
      } else if (this.state === "closed") {
        this.failureCount++;
        if (this.failureCount >= this.failureThreshold) {
          this.transitionTo("open");
        }
      }
    }
  }
}

export class CircuitBreakerVerifier implements Verifier {
  constructor(
    private readonly delegate: Verifier,
    readonly breaker: CircuitBreakerController,
  ) {}

  async verify(input: VerifyClaimInput): Promise<Verification> {
    return await this.breaker.execute(() => this.delegate.verify(input));
  }
}
