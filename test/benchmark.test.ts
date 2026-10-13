import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  aggregateTokenCost,
  computeCalibrationMetrics,
  computeClassMetrics,
  computeConfusionMatrix,
  computeLatencyMetrics,
  formatConsoleSummary,
  loadJsonlDataset,
  parseJsonlDataset,
  runBenchmark,
} from "../src/benchmark/index.js";
import {
  CachedVerifier,
  MemoryVerificationCache,
  RetryingVerifier,
} from "../src/resilience/index.js";
import type { BenchmarkItem, BenchmarkPrediction, Verifier } from "../src/index.js";

describe("Benchmark Harness", () => {
  describe("Dataset Loader", () => {
    it("parses valid JSONL content correctly", () => {
      const jsonl = `{"id":"1","claim":"Claim 1","evidence":[{"id":"e1","text":"Doc 1"}],"goldVerdict":"supported"}
{"id":"2","claim":"Claim 2","evidence":["Doc 2"],"goldVerdict":"contradicted"}`;

      const items = parseJsonlDataset(jsonl);
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        id: "1",
        claim: "Claim 1",
        evidence: [{ id: "e1", text: "Doc 1" }],
        goldVerdict: "supported",
      });
      expect(items[1]).toEqual({
        id: "2",
        claim: "Claim 2",
        evidence: [{ id: "evidence-1", text: "Doc 2" }],
        goldVerdict: "contradicted",
      });
    });

    it("throws error for invalid JSON or invalid verdicts", () => {
      expect(() => parseJsonlDataset("{invalid json")).toThrow("Failed to parse JSON");

      const invalidVerdict = `{"claim":"Test","evidence":[],"goldVerdict":"unknown"}`;
      expect(() => parseJsonlDataset(invalidVerdict)).toThrow(
        "goldVerdict' must be 'supported', 'contradicted', or 'insufficient'",
      );
    });

    it("loads synthetic fixture dataset file", async () => {
      const items = await loadJsonlDataset("fixtures/benchmark-fixture.jsonl");
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].goldVerdict).toBeDefined();
    });
  });

  describe("Metrics Computation & Provider Failure Handling", () => {
    it("computes accuracy, precision, recall, f1, and confusion matrix accurately for successful calls", () => {
      const predictions: BenchmarkPrediction[] = [
        {
          item: {
            id: "1",
            claim: "c1",
            evidence: [],
            goldVerdict: "supported",
          },
          verification: {
            claim: "c1",
            verdict: "supported",
            probabilities: { supported: 1, contradicted: 0, insufficient: 0 },
            confidence: 1,
            evidenceIds: [],
          },
          latencyMs: 10,
        },
        {
          item: {
            id: "2",
            claim: "c2",
            evidence: [],
            goldVerdict: "supported",
          },
          verification: {
            claim: "c2",
            verdict: "insufficient",
            probabilities: { supported: 0, contradicted: 0, insufficient: 1 },
            confidence: 1,
            evidenceIds: [],
          },
          latencyMs: 20,
        },
        {
          item: {
            id: "3",
            claim: "c3",
            evidence: [],
            goldVerdict: "contradicted",
          },
          verification: {
            claim: "c3",
            verdict: "contradicted",
            probabilities: { supported: 0, contradicted: 1, insufficient: 0 },
            confidence: 1,
            evidenceIds: [],
          },
          latencyMs: 30,
        },
      ];

      const confusion = computeConfusionMatrix(predictions);
      expect(confusion.supported.supported).toBe(1);
      expect(confusion.supported.insufficient).toBe(1);
      expect(confusion.contradicted.contradicted).toBe(1);

      const metrics = computeClassMetrics(confusion);
      expect(metrics.totalSamples).toBe(3);
      expect(metrics.accuracy).toBeCloseTo(2 / 3);

      expect(metrics.perClassMetrics.supported.precision).toBe(1.0); // 1 TP / 1 Pred S
      expect(metrics.perClassMetrics.supported.recall).toBe(0.5); // 1 TP / 2 Gold S
      expect(metrics.perClassMetrics.contradicted.precision).toBe(1.0);
      expect(metrics.perClassMetrics.contradicted.recall).toBe(1.0);
    });

    it("excludes failed calls from confusion matrix, accuracy, and support", () => {
      const predictions: BenchmarkPrediction[] = [
        {
          item: {
            id: "1",
            claim: "c1",
            evidence: [],
            goldVerdict: "insufficient",
          },
          latencyMs: 15,
          error: "API rate limit exceeded",
        },
        {
          item: {
            id: "2",
            claim: "c2",
            evidence: [],
            goldVerdict: "supported",
          },
          verification: {
            claim: "c2",
            verdict: "supported",
            probabilities: { supported: 1, contradicted: 0, insufficient: 0 },
            confidence: 1,
            evidenceIds: [],
          },
          latencyMs: 10,
        },
      ];

      const confusion = computeConfusionMatrix(predictions);
      expect(confusion.insufficient.insufficient).toBe(0);
      expect(confusion.insufficient.supported).toBe(0);
      expect(confusion.insufficient.contradicted).toBe(0);
      expect(confusion.supported.supported).toBe(1);

      const metrics = computeClassMetrics(confusion);
      expect(metrics.totalSamples).toBe(1);
      expect(metrics.accuracy).toBe(1.0);
      expect(metrics.perClassMetrics.insufficient.support).toBe(0);
      expect(metrics.perClassMetrics.supported.support).toBe(1);
    });

    it("computes calibration metrics (ECE and Brier score) excluding failures", () => {
      const predictions: BenchmarkPrediction[] = [
        {
          item: { id: "1", claim: "c1", evidence: [], goldVerdict: "supported" },
          verification: {
            claim: "c1",
            verdict: "supported",
            probabilities: { supported: 0.8, contradicted: 0.1, insufficient: 0.1 },
            confidence: 0.8,
            evidenceIds: [],
          },
          latencyMs: 10,
        },
        {
          item: { id: "2", claim: "c2", evidence: [], goldVerdict: "insufficient" },
          latencyMs: 15,
          error: "Network timeout",
        },
      ];

      const cal = computeCalibrationMetrics(predictions);
      expect(cal.ece).toBeDefined();
      expect(cal.brierScore).toBeDefined();
      // Brier score for 1 item: (0.8-1)^2 + (0.1-0)^2 + (0.1-0)^2 = 0.04 + 0.01 + 0.01 = 0.06
      expect(cal.brierScore).toBe(0.06);
      // ECE for 1 item with conf 0.8 and correct prediction = |1.0 - 0.8| = 0.2
      expect(cal.ece).toBe(0.2);
    });

    it("computes latency metrics correctly", () => {
      const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const stats = computeLatencyMetrics(latencies);

      expect(stats.minMs).toBe(10);
      expect(stats.maxMs).toBe(100);
      expect(stats.meanMs).toBe(55);
      expect(stats.totalMs).toBe(550);
      expect(stats.medianMs).toBe(55);
      expect(stats.p95Ms).toBeCloseTo(95.5);
    });

    it("aggregates token and cost metadata ignoring failed predictions", () => {
      const predictions: BenchmarkPrediction[] = [
        {
          item: { id: "1", claim: "c1", evidence: [], goldVerdict: "supported" },
          verification: {
            claim: "c1",
            verdict: "supported",
            probabilities: { supported: 1, contradicted: 0, insufficient: 0 },
            confidence: 1,
            evidenceIds: [],
          },
          latencyMs: 10,
          tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          cost: 0.002,
        },
        {
          item: { id: "2", claim: "c2", evidence: [], goldVerdict: "insufficient" },
          latencyMs: 12,
          error: "Auth error",
          tokens: { promptTokens: 500, completionTokens: 0, totalTokens: 500 },
          cost: 0.01,
        },
        {
          item: { id: "3", claim: "c3", evidence: [], goldVerdict: "contradicted" },
          latencyMs: 10,
          verification: {
            claim: "c3",
            verdict: "contradicted",
            probabilities: { supported: 0, contradicted: 1, insufficient: 0 },
            confidence: 1,
            evidenceIds: [],
            raw: {
              usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
              cost: 0.005,
            },
          },
        },
      ];

      const tokenCost = aggregateTokenCost(predictions);
      expect(tokenCost).toEqual({
        promptTokens: 300,
        completionTokens: 150,
        totalTokens: 450,
        totalCost: 0.007,
      });
    });
  });

  describe("Benchmark Runner & Summary", () => {
    it("acceptance criteria: 1 failed insufficient example and 1 successful supported example", async () => {
      const dataset: BenchmarkItem[] = [
        {
          id: "item-1",
          claim: "Unverifiable claim",
          evidence: [],
          goldVerdict: "insufficient",
        },
        {
          id: "item-2",
          claim: "Sky is blue",
          evidence: [{ id: "e1", text: "Sky is blue" }],
          goldVerdict: "supported",
        },
      ];

      const verifier: Verifier = {
        async verify({ claim }) {
          if (claim.includes("Unverifiable")) {
            throw new Error("Network / Provider auth failure");
          }
          return {
            claim,
            verdict: "supported",
            probabilities: { supported: 1, contradicted: 0, insufficient: 0 },
            confidence: 1,
            evidenceIds: ["e1"],
          };
        },
      };

      const result = await runBenchmark({
        verifier,
        dataset,
        verifierName: "TestVerifier",
      });

      expect(result.datasetSize).toBe(2);
      expect(result.scoredCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.failureRate).toBe(0.5);
      expect(result.accuracy).toBe(1.0); // 100% of successful examples correct
      expect(result.confusionMatrix.insufficient.insufficient).toBe(0);
      expect(result.confusionMatrix.supported.supported).toBe(1);
      expect(result.errorBreakdown["Network / Provider auth failure"]).toBe(1);

      const summary = formatConsoleSummary(result);
      expect(summary).toContain("Scored: 1, Failed: 1");
      expect(summary).toContain("Accuracy:     100.00%");
      expect(summary).toContain("Network / Provider auth failure: 1");
    });

    it("tracks cached and uncached latencies separately with CachedVerifier", async () => {
      const dataset: BenchmarkItem[] = [
        {
          id: "item-1",
          claim: "Water is wet",
          evidence: [{ id: "e1", text: "Water is wet" }],
          goldVerdict: "supported",
        },
        {
          id: "item-2",
          claim: "Water is wet", // identical claim & evidence to trigger cache hit
          evidence: [{ id: "e1", text: "Water is wet" }],
          goldVerdict: "supported",
        },
      ];

      const baseVerifier: Verifier = {
        async verify({ claim }) {
          return {
            claim,
            verdict: "supported",
            probabilities: { supported: 1, contradicted: 0, insufficient: 0 },
            confidence: 1,
            evidenceIds: ["e1"],
          };
        },
      };

      const cachedVerifier = new CachedVerifier(baseVerifier, {
        namespace: "test-ns",
        cache: new MemoryVerificationCache(),
      });

      const result = await runBenchmark({
        verifier: cachedVerifier,
        dataset,
        verifierName: "CachedTestVerifier",
      });

      expect(result.datasetSize).toBe(2);
      expect(result.scoredCount).toBe(2);
      expect(result.uncachedLatency).toBeDefined();
      expect(result.cachedLatency).toBeDefined();
      expect(cachedVerifier.stats.hits).toBe(1);
      expect(cachedVerifier.stats.misses).toBe(1);
    });

    it("preserves raw failed records and error metadata with RetryingVerifier and CachedVerifier", async () => {
      const dataset: BenchmarkItem[] = [
        {
          id: "item-1",
          claim: "Persistent failure",
          evidence: [],
          goldVerdict: "supported",
        },
      ];

      const failingVerifier: Verifier = {
        async verify() {
          throw new Error("HTTP 401 Unauthorized");
        },
      };

      const retryingVerifier = new RetryingVerifier(failingVerifier, { maxAttempts: 2 });
      const cachedVerifier = new CachedVerifier(retryingVerifier, {
        namespace: "test-ns",
        cache: new MemoryVerificationCache(),
      });

      const result = await runBenchmark({
        verifier: cachedVerifier,
        dataset,
      });

      expect(result.scoredCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.failureRate).toBe(1.0);
      expect(result.accuracy).toBe(0);
      expect(result.predictions[0].error).toBe("HTTP 401 Unauthorized");
      expect(result.predictions[0].verification).toBeUndefined();
    });

    it("persists machine-readable output to disk", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-benchmark-test-"));
      const outputPath = path.join(tempDir, "results.json");

      const verifier: Verifier = {
        async verify({ claim }) {
          return {
            claim,
            verdict: "supported",
            probabilities: { supported: 1, contradicted: 0, insufficient: 0 },
            confidence: 1,
            evidenceIds: [],
          };
        },
      };

      await runBenchmark({
        verifier,
        dataset: "fixtures/benchmark-fixture.jsonl",
        outputPath,
      });

      const fileContent = await fs.readFile(outputPath, "utf-8");
      const parsed = JSON.parse(fileContent);
      expect(parsed.accuracy).toBeDefined();
      expect(parsed.confusionMatrix).toBeDefined();
      expect(parsed.latency).toBeDefined();
      expect(parsed.scoredCount).toBeDefined();
      expect(parsed.failedCount).toBeDefined();
      expect(parsed.calibration).toBeDefined();

      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });
});
