import fs from "node:fs/promises";
import {
  computeClassMetrics, computeConfusionMatrix,
} from "./metrics.js";
import { validateBenchmarkItem } from "./dataset.js";
import { runBenchmark } from "./runner.js";
import type {
  BenchmarkItem, BenchmarkOptions, BenchmarkPrediction, BenchmarkResult,
} from "./types.js";

export interface MetamorphicRelation {
  type: string;
  baseId: string;
  expectedChange: "invariant" | "verdict_flip";
}
export interface AdversarialSample extends BenchmarkItem {
  category: string;
  rationale?: string;
  metamorphic?: MetamorphicRelation;
}

export interface CategoryReport {
  count: number;
  scored: number;
  failed: number;
  accuracy: number | null;
  macroF1: number | null;
}
export interface MetamorphicResult {
  id: string;
  baseId: string;
  category: string;
  expectedChange: "invariant" | "verdict_flip";
  actualChange: "invariant" | "verdict_flip" | null;
  passed: boolean | null;
  reason?: string;
}
export interface AdversarialReport {
  benchmark: BenchmarkResult;
  categoryResults: Record<string, CategoryReport>;
  metamorphic: MetamorphicResult[];
  scoredPairs: number;
  passingPairs: number;
}

function parseSample(value: unknown, line: number): AdversarialSample {
  const parsed = validateBenchmarkItem(value, line);
  const extra = value as Record<string, unknown>;
  if (typeof extra.category !== "string" || !extra.category.trim()) {
    throw new Error("Adversarial sample requires a category on line " + (line + 1));
  }
  const m = extra.metamorphic;
  let metamorphic: MetamorphicRelation | undefined;
  if (m !== undefined) {
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      throw new Error("Invalid metamorphic relation at line " + (line + 1));
    }
    const v = m as Record<string, unknown>;
    if (typeof v.type !== "string" || typeof v.baseId !== "string" ||
        !["invariant", "verdict_flip"].includes(String(v.expectedChange))) {
      throw new Error("Invalid metamorphic relation at line " + (line + 1));
    }
    metamorphic = v as unknown as MetamorphicRelation;
  }
  return {
    ...parsed, category: extra.category,
    ...(typeof extra.rationale === "string" ? { rationale: extra.rationale } : {}),
    ...(metamorphic ? { metamorphic } : {}),
  };
}

/** The source JSONL stays a synthetic regression suite, not an accuracy benchmark. */
export function parseAdversarialJsonl(text: string): AdversarialSample[] {
  const samples: AdversarialSample[] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new Error("Invalid JSON at adversarial line " + (i + 1)); }
    samples.push(parseSample(value, i));
  }
  const ids = new Set<string>();
  for (const sample of samples) {
    if (ids.has(sample.id)) throw new Error("Duplicate adversarial case ID: " + sample.id);
    ids.add(sample.id);
  }
  return samples;
}
export async function loadAdversarialDataset(path: string): Promise<AdversarialSample[]> {
  return parseAdversarialJsonl(await fs.readFile(path, "utf8"));
}

export function evaluateAdversarial(
  samples: AdversarialSample[], benchmark: BenchmarkResult,
): AdversarialReport {
  const byId = new Map(benchmark.predictions.map(p => [p.item.id, p]));
  const categories = new Map<string, BenchmarkPrediction[]>();
  for (const sample of samples) {
    const p = byId.get(sample.id);
    if (!p) continue; // Run subset: never fabricate an unexecuted prediction.
    const values = categories.get(sample.category) ?? [];
    values.push(p);
    categories.set(sample.category, values);
  }
  const categoryResults: Record<string, CategoryReport> = {};
  for (const [category, predictions] of categories) {
    const scored = predictions.filter(p => !!p.verification && !p.error);
    const { accuracy, macroMetrics } = computeClassMetrics(computeConfusionMatrix(scored));
    categoryResults[category] = {
      count: predictions.length, scored: scored.length,
      failed: predictions.length - scored.length,
      accuracy: scored.length ? accuracy : null,
      macroF1: scored.length ? macroMetrics.f1 : null,
    };
  }
  const metamorphic: MetamorphicResult[] = [];
  for (const sample of samples) {
    if (!sample.metamorphic) continue;
    const {baseId,expectedChange} = sample.metamorphic;
    const source = byId.get(baseId), variant = byId.get(sample.id);
    const valid = source?.verification && !source.error &&
      variant?.verification && !variant.error;
    const actualChange = valid
      ? (source.verification!.verdict === variant.verification!.verdict
        ? "invariant" as const : "verdict_flip" as const)
      : null;
    metamorphic.push({
      id: sample.id, baseId, category: sample.category, expectedChange,
      actualChange, passed: actualChange === null ? null : actualChange === expectedChange,
      ...(actualChange === null ? { reason: "Unscored/failed base or variant" } : {}),
    });
  }
  const scoredPairs = metamorphic.filter(x => x.passed !== null).length;
  return {
    benchmark, categoryResults, metamorphic, scoredPairs,
    passingPairs: metamorphic.filter(x => x.passed === true).length,
  };
}

/** Use the existing generic verifier metrics rather than replacing benchmark internals. */
export async function runAdversarialBenchmark(
  opts: Omit<BenchmarkOptions, "dataset"> & {dataset: AdversarialSample[] | string},
): Promise<AdversarialReport> {
  const samples = typeof opts.dataset === "string"
    ? await loadAdversarialDataset(opts.dataset) : opts.dataset;
  const benchmark = await runBenchmark({ ...opts, dataset: samples });
  return evaluateAdversarial(samples, benchmark);
}
