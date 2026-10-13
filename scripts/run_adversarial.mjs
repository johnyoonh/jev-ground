#!/usr/bin/env node
/** Synthetic, adversarial regression evaluation; not a model-accuracy claim. */
import fs from "node:fs/promises";
import path from "node:path";

function parse(args) {
  const out = { dataset: "data/benchmark/adversarial_metamorphic.jsonl",
    output: "data/reports/adversarial-local.json", verifier: "mock",
    model: "jev-1.13.0", maxExamples: undefined, live: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--live") { out.live = true; continue; }
    if (arg === "--help") {
      console.log("Usage: node scripts/run_adversarial.mjs [--dataset path] [--output path] [--verifier mock|jev] [--model id] [--max-examples n] [--live]");
      process.exit(0);
    }
    const name = ({ "--dataset": "dataset", "--output": "output",
      "--verifier": "verifier", "--model": "model", "--max-examples": "maxExamples" })[arg];
    if (!name || args[i + 1] === undefined) throw new Error("Invalid argument: " + arg);
    out[name] = args[++i];
  }
  if (!["mock", "jev"].includes(out.verifier)) throw new Error("Unknown verifier");
  if (out.verifier === "jev" && !out.live) throw new Error("Live Jev requires --live");
  if (out.verifier === "jev" && !process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY");
  out.maxExamples = out.maxExamples === undefined ? (out.live ? 20 : 10000) : Number(out.maxExamples);
  if (!Number.isInteger(out.maxExamples) || out.maxExamples < 1 || out.maxExamples > 10000) {
    throw new RangeError("Invalid --max-examples");
  }
  return out;
}
async function main() {
  const args = parse(process.argv.slice(2));
  const { loadAdversarialDataset, runAdversarialBenchmark, MockVerifier, JevVerifier,
    RetryingVerifier, CachedVerifier, MemoryVerificationCache } = await import("../dist/index.js");
  const cases = (await loadAdversarialDataset(args.dataset)).slice(0, args.maxExamples);
  if (!cases.length) throw new Error("No test cases");
  let verifier;
  if (args.verifier === "mock") {
    verifier = new MockVerifier();
  } else {
    const jev = new JevVerifier({ model: args.model });
    verifier = new CachedVerifier(
      new RetryingVerifier(jev, { maxAttempts: 3 }),
      { namespace: jev.cacheNamespace, cache: new MemoryVerificationCache() },
    );
    console.warn("Live evaluation may incur API charges. Example cap:", cases.length);
  }
  const report = await runAdversarialBenchmark({
    verifier, dataset: cases, verifierName: args.verifier + ":" + args.model,
  });
  await fs.mkdir(path.dirname(args.output), { recursive: true, mode: 0o700 });
  await fs.writeFile(args.output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log("Scored:", report.benchmark.scored, "failed:", report.benchmark.failed,
    "categories:", Object.keys(report.categoryResults).length,
    "metamorphic pairs:", report.passingPairs + "/" + report.scoredPairs);
  console.log("Results:", args.output);
  if (report.benchmark.failed) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
