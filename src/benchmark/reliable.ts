import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Verifier } from "../types.js";
import { loadJsonlDataset } from "./dataset.js";
import {
  aggregateTokenCost, computeCalibrationMetrics, computeClassMetrics, computeConfusionMatrix, computeLatencyMetrics,
} from "./metrics.js";
import type {
  BenchmarkItem, BenchmarkOptions, BenchmarkPrediction, BenchmarkResult,
} from "./types.js";

export interface ReliableBenchmarkOptions extends BenchmarkOptions {
  concurrency?: number;
  /**
   * Opt-in plaintext JSONL journal. Contains claims and evidence; keep in an
   * ignored/private directory. Runs must have a fixed model/rubric fingerprint.
   */
  checkpointPath?: string;
  /** Required for checkpoints. Include resolved/pinned model and rubric version. */
  runFingerprint?: string;
  resume?: boolean;
  /** Bypass a caching wrapper for the first uncached, representative API canary. */
  preflightVerifier?: Verifier;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}
export interface ReliableBenchmarkResult extends BenchmarkResult {
  runFingerprint: string;
  resumed: number;
  preflightIndex: number | null;
}
const FORMAT = "jev-ground-checkpoint-v1";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function message(error: unknown): string {
  return error instanceof Error ? error.name + ": " + error.message : String(error);
}
function assertOptions(opts: ReliableBenchmarkOptions): void {
  const concurrency = opts.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new RangeError("concurrency must be between 1 and 64");
  }
  if (opts.resume && !opts.checkpointPath) throw new Error("resume requires checkpointPath");
  if (opts.checkpointPath && !opts.runFingerprint?.trim()) {
    throw new Error("checkpoint requires a nonempty pinned model/rubric runFingerprint");
  }
}
function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Evaluation aborted; checkpoint preserved");
}

async function loadCheckpoint(
  checkpointPath: string, fingerprint: string, items: BenchmarkItem[],
): Promise<Map<number, BenchmarkPrediction>> {
  const data = await fs.readFile(checkpointPath, "utf8");
  if (!data.endsWith("\n")) throw new Error("Checkpoint has incomplete trailing record");
  const lines = data.trimEnd().split("\n");
  const header: unknown = JSON.parse(lines.shift() ?? "{}");
  if (!header || typeof header !== "object" ||
      (header as Record<string, unknown>).format !== FORMAT ||
      (header as Record<string, unknown>).fingerprint !== fingerprint) {
    throw new Error("Checkpoint fingerprint does not match dataset/model/rubric");
  }
  const previous = new Map<number, BenchmarkPrediction>();
  for (const text of lines) {
    const entry = JSON.parse(text) as { type?: string; index?: number; prediction?: BenchmarkPrediction };
    if (entry.type !== "result" || !Number.isInteger(entry.index) ||
        entry.index! < 0 || entry.index! >= items.length ||
        entry.prediction?.item?.id !== items[entry.index!].id) {
      throw new Error("Malformed or stale checkpoint record");
    }
    previous.set(entry.index!, entry.prediction);
  }
  return previous;
}

/**
 * A bounded, resumable benchmark with an uncached preflight. Provider failures
 * never become "insufficient" model predictions. Successful checkpoint records
 * are reused only when the exact dataset and run fingerprint match.
 */
export async function runReliableBenchmark(
  opts: ReliableBenchmarkOptions,
): Promise<ReliableBenchmarkResult> {
  assertOptions(opts);
  const items = typeof opts.dataset === "string"
    ? await loadJsonlDataset(opts.dataset) : opts.dataset;
  if (items.length === 0) throw new Error("Cannot benchmark an empty dataset");
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error("Dataset IDs must be unique to permit reliable resume");
  }
  const name = opts.verifierName ?? opts.verifier.constructor?.name ?? "Verifier";
  const fingerprint = hash({
    format: FORMAT, items, verifierName: name, runFingerprint: opts.runFingerprint ?? "ephemeral",
  });
  const slots: Array<BenchmarkPrediction | undefined> = Array(items.length);
  let resumed = 0;
  if (opts.checkpointPath) {
    const dest = opts.checkpointPath;
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    if (opts.resume) {
      const previous = await loadCheckpoint(dest, fingerprint, items);
      for (const [index, prediction] of previous) {
        if (prediction.verification && !prediction.error) {
          slots[index] = prediction;
          resumed++;
        }
      }
    } else {
      await fs.writeFile(dest, JSON.stringify({
        format: FORMAT, fingerprint, count: items.length,
        createdAt: new Date().toISOString(),
      }) + "\n", { flag: "wx", mode: 0o600 });
    }
  }

  let journal: Promise<void> = Promise.resolve();
  const persist = async (index: number, prediction: BenchmarkPrediction): Promise<void> => {
    if (!opts.checkpointPath) return;
    const text = JSON.stringify({ type: "result", index, prediction }) + "\n";
    journal = journal.then(() => fs.appendFile(opts.checkpointPath!, text, "utf8"));
    await journal;
  };
  const evaluate = async (index: number, verifier: Verifier): Promise<BenchmarkPrediction> => {
    abortIfRequested(opts.signal);
    const item = items[index];
    const start = performance.now();
    try {
      const verification = await verifier.verify({ claim: item.claim, evidence: item.evidence });
      if (!verification || verification.claim !== item.claim ||
          !["supported", "contradicted", "insufficient"].includes(verification.verdict)) {
        throw new Error("Provider returned invalid claim/verdict");
      }
      return { item, verification, latencyMs: performance.now() - start };
    } catch (error) {
      return { item, error: message(error), latencyMs: performance.now() - start };
    }
  };

  // Choose a nonempty-evidence sample to avoid confusing deterministic no-evidence
  // responses with an actual connectivity/schema preflight.
  const missing = items.map((_, index) => index).filter(i => !slots[i]);
  const preflightIndex = missing.find(i => items[i].evidence.length > 0) ?? missing[0] ?? null;
  if (preflightIndex !== null) {
    const canary = await evaluate(preflightIndex, opts.preflightVerifier ?? opts.verifier);
    if (canary.error || canary.verification?.cacheHit === true) {
      throw new Error("Preflight failed or was cached; no bulk calls started: " +
        (canary.error ?? "cached response"));
    }
    slots[preflightIndex] = canary;
    await persist(preflightIndex, canary);
  }
  let completed = slots.filter(Boolean).length;
  opts.onProgress?.(completed, items.length);
  const pending = items.map((_, index) => index).filter(i => !slots[i]);
  let cursor = 0;
  let aborted = false;
  let budgetExhausted = false;
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      if (opts.signal?.aborted) { aborted = true; return; }
      if (budgetExhausted) return;
      const index = pending[cursor++];
      const prediction = await evaluate(index, opts.verifier);
      slots[index] = prediction;
      await persist(index, prediction);
      completed++;
      opts.onProgress?.(completed, items.length);
      // Budget exhaustion is an execution state. Do not launch further cases,
      // and leave successfully finished records available for exact resume.
      if (prediction.error?.startsWith("ProviderBudgetExceededError:")) {
        budgetExhausted = true;
        return;
      }
    }
  }
  const threads = Math.min(opts.concurrency ?? 4, pending.length);
  await Promise.all(Array.from({ length: threads }, () => worker()));
  if (aborted || opts.signal?.aborted) {
    throw new Error("Evaluation aborted; successful checkpoint records preserved");
  }
  if (budgetExhausted) {
    throw new Error("Evaluation stopped by provider request budget; checkpoint preserved for --resume");
  }
  const predictions = slots.map((prediction, index) => {
    if (!prediction) throw new Error("Missing benchmark result " + index);
    return prediction;
  });
  const scored = predictions.filter(p => p.verification && !p.error).length;
  const confusionMatrix = computeConfusionMatrix(predictions);
  const { accuracy, perClassMetrics, macroMetrics } = computeClassMetrics(confusionMatrix);
  const failed = predictions.length - scored;
  const calibration = computeCalibrationMetrics(predictions);
  const cached = predictions.filter(p => p.verification?.cacheHit === true).map(p => p.latencyMs);
  const uncached = predictions.filter(p => p.verification?.cacheHit !== true && !p.error).map(p => p.latencyMs);
  const errorBreakdown: Record<string, number> = {};
  for (const p of predictions.filter(p => p.error || !p.verification)) {
    const reason = p.error?.split(":")[0] ?? "MissingVerification";
    errorBreakdown[reason] = (errorBreakdown[reason] ?? 0) + 1;
  }
  const result: ReliableBenchmarkResult = {
    timestamp: new Date().toISOString(), verifierName: name, datasetSize: items.length,
    scored, failed, failureRate: failed / items.length, errorBreakdown,
    ...(calibration ? { calibration } : {}),
    ...(cached.length ? { cachedLatency: computeLatencyMetrics(cached) } : {}),
    ...(uncached.length ? { uncachedLatency: computeLatencyMetrics(uncached) } : {}),
    runFingerprint: fingerprint,
    resumed, preflightIndex, accuracy, perClassMetrics, macroMetrics,
    confusionMatrix, latency: computeLatencyMetrics(predictions.map(p => p.latencyMs)),
    ...(aggregateTokenCost(predictions)
      ? { tokenCost: aggregateTokenCost(predictions) } : {}),
    predictions,
  };
  if (opts.outputPath) {
    await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
    const temp = opts.outputPath + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temp, JSON.stringify(result, null, 2), { mode: 0o600 });
      await fs.rename(temp, opts.outputPath);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return result;
}
