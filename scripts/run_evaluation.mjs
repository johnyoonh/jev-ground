#!/usr/bin/env node
/**
 * Live evaluator for the Jules benchmark runner (PR #9).
 * Explicit --live opt-in limits accidental paid calls.
 */
import { readFile } from "node:fs/promises";

function usage() {
  console.log([
    "Usage: node scripts/run_evaluation.mjs --dataset data/normalized/dev.jsonl --live [options]",
    "  --max-examples 20      Bound billable verifier calls (default 20)",
    "  --model jev-latest     TypeSafe model/version (default jev-latest)",
    "  --cache-dir .cache/jev-ground   Persist successful results (optional)",
    "  --output data/reports/results.json",
    "  --max-attempts 4      Max attempts for transient API/network failures",
    "  --no-cache            Disable cache entirely",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = { maxExamples: 20, model: "jev-latest", maxAttempts: 4,
    output: "data/reports/jev-results.json", live: false, cacheDir: null, noCache: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") { usage(); process.exit(0); }
    if (arg === "--live") { args.live = true; continue; }
    if (arg === "--no-cache") { args.noCache = true; continue; }
    const key = ({ "--dataset": "dataset", "--max-examples": "maxExamples",
      "--model": "model", "--cache-dir": "cacheDir", "--output": "output",
      "--max-attempts": "maxAttempts" })[arg];
    if (!key || i + 1 >= argv.length) throw new Error("Unknown or missing argument: " + arg);
    args[key] = argv[++i];
  }
  args.maxExamples = Number(args.maxExamples);
  args.maxAttempts = Number(args.maxAttempts);
  if (!args.dataset) throw new Error("--dataset is required");
  if (!Number.isInteger(args.maxExamples) || args.maxExamples < 1 || args.maxExamples > 10000) {
    throw new Error("--max-examples must be in [1,10000]");
  }
  if (!Number.isInteger(args.maxAttempts) || args.maxAttempts < 1 || args.maxAttempts > 10) {
    throw new Error("--max-attempts must be in [1,10]");
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
    JevVerifier, RetryingVerifier, CachedVerifier, FileVerificationCache,
    MemoryVerificationCache, runBenchmark, loadJsonlDataset,
  } = await import("../dist/index.js");
  if (typeof runBenchmark !== "function" || typeof loadJsonlDataset !== "function") {
    throw new Error("Merge Jules benchmark PR #9 and run npm run build first.");
  }
  const items = await loadJsonlDataset(opts.dataset);
  if (items.length === 0) throw new Error("Dataset is empty.");
  const subset = items.slice(0, opts.maxExamples);
  console.log("Running " + subset.length + "/" + items.length + " examples. No provider-side billing cap is configured.");
  const retried = new RetryingVerifier(new JevVerifier({ model: opts.model }), {
    maxAttempts: opts.maxAttempts, baseDelayMs: 500, maxDelayMs: 8000,
    onRetry: (_error, attempt, delay) =>
      console.warn("Transient error; retry " + attempt + " in " + Math.round(delay) + " ms"),
  });
  const verifier = opts.noCache
    ? retried
    : new CachedVerifier(retried, {
        namespace: "jev-ground:factuality-schema-v1:" + opts.model,
        cache: opts.cacheDir
          ? new FileVerificationCache(opts.cacheDir)
          : new MemoryVerificationCache(),
        ttlMs: 30 * 86400 * 1000,
      });
  const report = await runBenchmark({
    verifier, dataset: subset, verifierName: opts.model, outputPath: opts.output,
  });
  console.log("Accuracy:", report.accuracy, "macro-F1:", report.macroMetrics.f1);
  console.log("Retries:", retried.stats, "cache:", "stats" in verifier ? verifier.stats : "disabled");
  console.log("Output:", opts.output);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
