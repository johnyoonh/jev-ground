# Provider request budgets and outage circuit breaker

Issue #17 adds controls **below** the benchmark example limit. A single
example can produce multiple HTTP attempts because of retries or provider
chunking; a batch can also contain multiple claim judgments.

## Hard limit on actual SDK calls

`ProviderCallBudget.reserve()` is a **synchronous request-admission gate**.
Use `JevVerifier({beforeRequest: info => budget.reserve(...)})` to reserve
one unit before *every* outbound Jev `systemOne` call. The official SDK
retries are disabled (`maxRetries: 0`) and the outer `RetryingVerifier`
owns bounded retries; every retry invokes this gate again. Concurrent
calls cannot exceed the configured `maxRequests` reservation count.
Budget exhaustion raises `ProviderBudgetExceededError` with
`code: PROVIDER_BUDGET_EXHAUSTED`, never a three-way factuality verdict.

```ts
import { JevVerifier, ProviderCallBudget, RetryingVerifier } from 'jev-ground';
const budget = new ProviderCallBudget({maxRequests: 25, maxWallClockMs: 600_000});
const jev = new JevVerifier({
  model: 'jev-1.13.0',
  beforeRequest: () => budget.reserve(),
});
const verifier = new RetryingVerifier(jev, {maxAttempts: 4});
```

## Cost estimates, not a provider-side spending cap

The budget also optionally reserves **estimated** input tokens and USD
by passing `estimatedTokens`, `estimatedCostUsd` into `reserve`.
Limits require an estimate for each request; missing figures are rejected
instead of silently bypassing the configured ceiling. The live evaluation
runner uses `payloadChars / 4` as a rough input-token heuristic. It
cannot guarantee actual tokens or dollars: model tokenization, output
tokens, provider prices and external charges may differ.
Set a billing/spending limit with the provider as a separate control.

## Circuit breaker

`CircuitBreakerVerifier` opens after N consecutive transient 429/5xx or
transport errors. During cooldown it declines requests without making
an API call; after the interval exactly **one half-open probe** is
allowed. A successful probe closes the breaker, a transient failed
probe opens it again. Other concurrent probes are refused. The default
is 3 transient operation failures and a 30-second cooldown.

Stacking recommendation: `CachedVerifier(CircuitBreakerVerifier(
RetryingVerifier(JevVerifier)))`. The uncached benchmark preflight still
goes through circuit and budget; cache hits do not spend requests.

## Live evaluation CLI

```bash
node scripts/run_evaluation.mjs --dataset data/normalized/averitec-dev-60.jsonl \
  --model jev-1.13.0 --max-examples 20 --max-provider-attempts 25 \
  --circuit-failures 3 --circuit-cooldown-ms 30000 \
  --concurrency 4 --max-runtime-ms 600000 --live
```

Optional: `--max-estimated-tokens`, `--max-estimated-usd`,
`--usd-per-1000-estimated-tokens` (user-supplied estimate).
Use `--resume` with the existing checkpoint. Budgeted cases that could
not start are **execution errors**, not `insufficient` judgments. The
benchmark's error counts must be interpreted alongside successful
factuality predictions.

Do not construe mock tests, request-count ceilings, or synthetic
estimates as actual measured live Jev accuracy, latency or billing.
