import { describe, expect, it } from "vitest";
import {
  buildCategoryMetrics,
  buildConfusionMatrix,
  calculateMacroMetrics,
  evaluateMetamorphicChecks,
  loadJsonlDataset,
  runBenchmark,
  type BenchmarkItem,
  type CasePrediction,
  type Verification,
  type Verifier,
} from "../src/index.js";

describe("Benchmark and Evaluation Suite", () => {
  it("loads and parses JSONL benchmark dataset correctly", async () => {
    const items = await loadJsonlDataset("data/benchmark/adversarial_metamorphic.jsonl");
    expect(items.length).toBeGreaterThanOrEqual(30);

    const categories = new Set(items.map((i) => i.category));
    expect(categories).toContain("prompt_injection");
    expect(categories).toContain("conflicting_stale");
    expect(categories).toContain("semantic_robustness");
    expect(categories).toContain("distractor_passages");
    expect(categories).toContain("insufficient_vs_contradicted");
  });

  it("calculates confusion matrix correctly", () => {
    const predictions: CasePrediction[] = [
      {
        id: "1",
        claim: "c1",
        goldVerdict: "supported",
        predictedVerdict: "supported",
        confidence: 0.9,
        probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
        category: "cat1",
        correct: true,
      },
      {
        id: "2",
        claim: "c2",
        goldVerdict: "contradicted",
        predictedVerdict: "insufficient",
        confidence: 0.8,
        probabilities: { supported: 0.1, contradicted: 0.1, insufficient: 0.8 },
        category: "cat1",
        correct: false,
      },
    ];

    const conf = buildConfusionMatrix(predictions);
    expect(conf.matrix.supported.supported).toBe(1);
    expect(conf.matrix.contradicted.insufficient).toBe(1);
    expect(conf.total).toBe(2);
  });

  it("calculates accuracy and macro F1 metrics correctly", () => {
    const predictions: CasePrediction[] = [
      {
        id: "1",
        claim: "c1",
        goldVerdict: "supported",
        predictedVerdict: "supported",
        confidence: 0.9,
        probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
        category: "cat1",
        correct: true,
      },
      {
        id: "2",
        claim: "c2",
        goldVerdict: "contradicted",
        predictedVerdict: "contradicted",
        confidence: 0.9,
        probabilities: { supported: 0.05, contradicted: 0.9, insufficient: 0.05 },
        category: "cat1",
        correct: true,
      },
    ];

    const metrics = calculateMacroMetrics(predictions);
    expect(metrics.accuracy).toBe(1.0);
    expect(metrics.macroF1).toBe(1.0);
  });

  it("evaluates metamorphic checks (distractor invariance & date swap)", () => {
    const dataset: BenchmarkItem[] = [
      {
        id: "base-1",
        claim: "Claim A",
        evidence: [{ id: "e1", text: "Text A" }],
        goldVerdict: "supported",
        category: "distractor_passages",
      },
      {
        id: "variant-1",
        claim: "Claim A",
        evidence: [{ id: "e1", text: "Text A" }, { id: "e2", text: "Unrelated noise" }],
        goldVerdict: "supported",
        category: "distractor_passages",
        metamorphic: { type: "distractor_insertion", baseId: "base-1", expectedChange: "invariant" },
      },
      {
        id: "base-2",
        claim: "Claim B",
        evidence: [{ id: "e1", text: "Date is 2024" }],
        goldVerdict: "supported",
        category: "conflicting_stale",
      },
      {
        id: "variant-2",
        claim: "Claim B",
        evidence: [{ id: "e1", text: "Date is 2025" }],
        goldVerdict: "contradicted",
        category: "conflicting_stale",
        metamorphic: { type: "date_swap", baseId: "base-2", expectedChange: "verdict_flip" },
      },
    ];

    const predMap = new Map<string, CasePrediction>([
      [
        "base-1",
        {
          id: "base-1",
          claim: "Claim A",
          goldVerdict: "supported",
          predictedVerdict: "supported",
          confidence: 0.9,
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          category: "distractor_passages",
          correct: true,
        },
      ],
      [
        "variant-1",
        {
          id: "variant-1",
          claim: "Claim A",
          goldVerdict: "supported",
          predictedVerdict: "supported",
          confidence: 0.9,
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          category: "distractor_passages",
          correct: true,
        },
      ],
      [
        "base-2",
        {
          id: "base-2",
          claim: "Claim B",
          goldVerdict: "supported",
          predictedVerdict: "supported",
          confidence: 0.9,
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          category: "conflicting_stale",
          correct: true,
        },
      ],
      [
        "variant-2",
        {
          id: "variant-2",
          claim: "Claim B",
          goldVerdict: "contradicted",
          predictedVerdict: "contradicted",
          confidence: 0.9,
          probabilities: { supported: 0.05, contradicted: 0.9, insufficient: 0.05 },
          category: "conflicting_stale",
          correct: true,
        },
      ],
    ]);

    const metaResults = evaluateMetamorphicChecks(dataset, predMap);
    expect(metaResults.length).toBe(2);
    expect(metaResults[0].passed).toBe(true);
    expect(metaResults[1].passed).toBe(true);
  });

  it("runs full benchmark with mock verifier and enforces threshold failures", async () => {
    class ConstantVerifier implements Verifier {
      async verify(): Promise<Verification> {
        return {
          claim: "test",
          verdict: "supported",
          confidence: 0.9,
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          evidenceIds: [],
        };
      }
    }

    const report = await runBenchmark({
      verifier: new ConstantVerifier(),
      dataset: "data/benchmark/adversarial_metamorphic.jsonl",
      thresholds: {
        minOverallAccuracy: 0.95,
        minMetamorphicPassRate: 0.90,
      },
    });

    expect(report.totalCases).toBeGreaterThanOrEqual(30);
    expect(report.thresholdsPassed).toBe(false);
    expect(report.thresholdFailures?.length).toBeGreaterThan(0);
  });
});
