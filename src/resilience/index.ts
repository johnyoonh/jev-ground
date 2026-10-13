import type { Verifier } from "../types.js";
import { BudgetedVerifier, RunBudgetController, type RunBudgetOptions } from "./budget.js";
import { CachedVerifier, type CachedVerifierOptions } from "./cache.js";
import { CircuitBreakerController, CircuitBreakerVerifier, type CircuitBreakerOptions } from "./circuit-breaker.js";
import { RetryingVerifier, type RetryOptions } from "./retry.js";

export * from "./cache.js";
export * from "./retry.js";
export * from "./budget.js";
export * from "./circuit-breaker.js";

export interface ResilientVerifierOptions {
  budget?: RunBudgetOptions | RunBudgetController;
  retry?: RetryOptions;
  circuitBreaker?: CircuitBreakerOptions | CircuitBreakerController;
  cache?: CachedVerifierOptions;
}

/**
 * Creates a fully composed verifier stack with caching, retries, run budget limits, and circuit breaker.
 *
 * Execution stack order:
 * CachedVerifier -> RetryingVerifier -> BudgetedVerifier -> CircuitBreakerVerifier -> Provider
 */
export function createResilientVerifier(
  providerVerifier: Verifier,
  options: ResilientVerifierOptions = {},
): Verifier {
  let verifier = providerVerifier;

  if (options.circuitBreaker) {
    const breaker = options.circuitBreaker instanceof CircuitBreakerController
      ? options.circuitBreaker
      : new CircuitBreakerController(options.circuitBreaker);
    verifier = new CircuitBreakerVerifier(verifier, breaker);
  }

  if (options.budget) {
    const budget = options.budget instanceof RunBudgetController
      ? options.budget
      : new RunBudgetController(options.budget);
    verifier = new BudgetedVerifier(verifier, budget);
  }

  if (options.retry) {
    verifier = new RetryingVerifier(verifier, options.retry);
  }

  if (options.cache) {
    verifier = new CachedVerifier(verifier, options.cache);
  }

  return verifier;
}
