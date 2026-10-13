#!/usr/bin/env node
/**
 * Live evaluator for the Jules benchmark runner (PR #9).
 * Explicit --live opt-in limits accidental paid calls.
 */
function usage() {
  console.log([
    "Usage: node scripts/run_evaluation.mjs --dataset data/normalized/dev.jsonl --live [options]",
    "  --max-examples 20      Bound billable verifier calls (default 20)",
    "  --model jev-1.13.0     Pinned TypeSafe model/version (default jev-1.13.0)",
    "  --cache-dir .cache/jev-ground   Persist successful results (optional)",
    "  --output data/reports/results.json",
    "  --max-attempts 4      Max attempts per retry operation",
    "  --max-provider-attempts 25   Hard total SDK request cap, including retries",
    "  --max-runtime-ms 600000     Deadline for initiating new API attempts",
    "  --circuit-failures 3        Open circuit after consecutive transient errors",
    "  --circuit-cooldown-ms 30000 Circuit cooldown before one probe",
    "  --max-estimated-tokens N    Optional approximate input token budget",
    "  --usd-per-1000-estimated-tokens N    User-provided estimate, not TypeSafe pricing",
    "  --max-estimated-usd N       Optional approximate USD cap (requires price estimate)",
    "  --concurrency 4       Maximum simultaneous verifier requests",
    "  --checkpoint-path PATH    Durable JSONL journal (default: output + .checkpoint.jsonl)",
    "  --resume              Resume from matching prior journal",
    "  --no-cache            Disable cache entirely",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = { maxExamples: 20, model: "jev-1.13.0", maxAttempts: 4, concurrency: 4,
    maxProviderAttempts: 25, maxRuntimeMs: 600000, circuitFailures: 3, circuitCooldownMs: 30000,
    maxEstimatedTokens: null, maxEstimatedUsd: null, usdPer1000EstimatedTokens: null,
    resume: false, checkpointPath: null,
    output: "data/reports/jev-results.json", live: false, cacheDir: null, noCache: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") { usage(); process.exit(0); }
    if (arg === "--live") { args.live = true; continue; }
    if (arg === "--no-cache") { args.noCache = true; continue; }
    if (arg === "--resume") { args.resume = true; continue; }
    const key = ({ "--dataset": "dataset", "--max-examples": "maxExamples",
      "--model": "model", "--cache-dir": "cacheDir", "--output": "output",
      "--max-attempts": "maxAttempts", "--concurrency": "concurrency",
      "--checkpoint-path": "checkpointPath", "--max-provider-attempts": "maxProviderAttempts",
      "--max-runtime-ms": "maxRuntimeMs", "--circuit-failures": "circuitFailures",
      "--circuit-cooldown-ms": "circuitCooldownMs",
      "--max-estimated-tokens": "maxEstimatedTokens", "--max-estimated-usd": "maxEstimatedUsd",
      "--usd-per-1000-estimated-tokens": "usdPer1000EstimatedTokens" })[arg];
    if (!key || i + 1 >= argv.length) throw new Error("Unknown or missing argument: " + arg);
    args[key] = argv[++i];
  }
  args.maxExamples = Number(args.maxExamples);
  args.maxAttempts = Number(args.maxAttempts);
  args.concurrency = Number(args.concurrency);
  for (const key of ["maxProviderAttempts","maxRuntimeMs","circuitFailures","circuitCooldownMs"]) {
    args[key] = Number(args[key]);
    if (!Number.isSafeInteger(args[key]) || args[key] < (key==="circuitCooldownMs" ? 0 : 1)) {
      throw new Error("Invalid " + key);
    }
  }
  for (const key of ["maxEstimatedTokens","maxEstimatedUsd","usdPer1000EstimatedTokens"]) {
    if (args[key] === null) continue;
    args[key] = Number(args[key]);
    if (!Number.isFinite(args[key]) || args[key] < 0) throw new Error("Invalid "+key);
  }
  if (args.maxEstimatedUsd !== null && args.usdPer1000EstimatedTokens === null) {
    throw new Error("--max-estimated-usd requires --usd-per-1000-estimated-tokens");
  }
  if (!args.dataset) throw new Error("--dataset is required");
  if (!Number.isInteger(args.maxExamples) || args.maxExamples < 1 || args.maxExamples > 10000) {
    throw new Error("--max-examples must be in [1,10000]");
  }
  if (!Number.isInteger(args.maxAttempts) || args.maxAttempts < 1 || args.maxAttempts > 10) {
    throw new Error("--max-attempts must be in [1,10]");
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 32) {
    throw new Error("--concurrency must be in [1,32]");
  }
  return args;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.live) {
    console.error("No paid calls made. Add --live after reviewing dataset and example limits.");
    usage();
    process.exitCode = 2;
    return;
  }
  if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY before --live.");
  const {
    JevVerifier, RetryingVerifier, CircuitBreakerVerifier, ProviderCallBudget,
    CachedVerifier, FileVerificationCache, MemoryVerificationCache,
    runReliableBenchmark, loadJsonlDataset,
  } = await import("../dist/index.js");
  if (typeof runReliableBenchmark !== "function" || typeof loadJsonlDataset !== "function") {
    throw new Error("Build the updated jev-ground package first (npm run build).");
  }
  const items = await loadJsonlDataset(opts.dataset);
  if (items.length === 0) throw new Error("Dataset is empty.");
  const subset = items.slice(0, opts.maxExamples);
  const budget = new ProviderCallBudget({
    maxRequests: opts.maxProviderAttempts, maxWallClockMs: opts.maxRuntimeMs,
    ...(opts.maxEstimatedTokens !== null ? { maxEstimatedTokens: opts.maxEstimatedTokens } : {}),
    ...(opts.maxEstimatedUsd !== null ? { maxEstimatedCostUsd: opts.maxEstimatedUsd } : {}),
  });
  console.log("Running " + subset.length + "/" + items.length +
    " examples; hard request-attempt limit " + opts.maxProviderAttempts +
    ". Token/USD figures are estimates, not provider billing limits.");
  const jev = new JevVerifier({
    model: opts.model,
    beforeRequest: info => {
      // Character count is an approximation, NOT true model tokenization.
      // Actual provider charges may be higher due to output, SDK, or server costs.
      const tokens = Math.ceil(info.payloadChars / 4);
      budget.reserve({
        estimatedTokens: tokens,
        ...(opts.usdPer1000EstimatedTokens !== null
          ? { estimatedCostUsd: tokens * opts.usdPer1000EstimatedTokens / 1000 } : {}),
      });
    },
  });
  const retried = new RetryingVerifier(jev, {
    maxAttempts: opts.maxAttempts, baseDelayMs: 500, maxDelayMs: 8000,
    onRetry: (_error, attempt, delay) =>
      console.warn("Transient error; retry " + attempt + " in " + Math.round(delay) + " ms"),
  });
  const breaker = new CircuitBreakerVerifier(retried, {
    failureThreshold: opts.circuitFailures, cooldownMs: opts.circuitCooldownMs,
  });
  const verifier = opts.noCache
    ? breaker
    : new CachedVerifier(breaker, {
        namespace: jev.cacheNamespace,
        cache: opts.cacheDir
          ? new FileVerificationCache(opts.cacheDir)
          : new MemoryVerificationCache(),
        ttlMs: 30 * 86400 * 1000,
      });
  const report = await runReliableBenchmark({
    verifier,
    preflightVerifier: breaker, // Bypass cache but honor budget/circuit for live canary.
    dataset: subset,
    verifierName: opts.model,
    runFingerprint: jev.cacheNamespace,
    concurrency: opts.concurrency,
    checkpointPath: opts.checkpointPath ?? opts.output + ".checkpoint.jsonl",
    resume: opts.resume,
    outputPath: opts.output,
  });
  const failures = report.predictions.filter(p => p.error).length;
  if (failures > 0) {
    console.error("WARNING:", failures, "provider failures (excluded from accuracy/F1).");
    process.exitCode = 1;
  } else {
    console.log("Accuracy:", report.accuracy, "macro-F1:", report.macroMetrics.f1);
  }
  console.log("Request budget:", budget.snapshot, "circuit:", breaker.state, breaker.stats);
  console.log("Retries:", retried.stats, "cache:", "stats" in verifier ? verifier.stats : "disabled");
  console.log("Output:", opts.output, "resumed:", report.resumed, "preflight:", report.preflightIndex);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
