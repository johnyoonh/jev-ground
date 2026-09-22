import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  aggregateTokenCost,
  computeClassMetrics,
  computeConfusionMatrix,
  computeLatencyMetrics,
  formatConsoleSummary,
  loadJsonlDataset,
  parseJsonlDataset,
  runBenchmark,
} from "../src/benchmark/index.js";
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

  describe("Metrics Computation", () => {
    it("computes accuracy, precision, recall, f1, and confusion matrix accurately", () => {
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

    it("aggregates token and cost metadata", () => {
      const predictions: BenchmarkPrediction[] = [
        {
          item: { id: "1", claim: "c1", evidence: [], goldVerdict: "supported" },
          latencyMs: 10,
          tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          cost: 0.002,
        },
        {
          item: { id: "2", claim: "c2", evidence: [], goldVerdict: "contradicted" },
          latencyMs: 10,
          verification: {
            claim: "c2",
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
    it("runs benchmark over generic verifier and formats summary", async () => {
      const dataset: BenchmarkItem[] = [
        {
          id: "item-1",
          claim: "Sky is blue",
          evidence: [{ id: "e1", text: "The sky appears blue due to Rayleigh scattering." }],
          goldVerdict: "supported",
        },
        {
          id: "item-2",
          claim: "Water is dry",
          evidence: [{ id: "e2", text: "Water is a liquid that causes wetness." }],
          goldVerdict: "contradicted",
        },
      ];

      const verifier: Verifier = {
        async verify({ claim }) {
          const verdict = claim.includes("blue") ? "supported" : "contradicted";
          return {
            claim,
            verdict,
            probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
            confidence: 0.9,
            evidenceIds: [],
          };
        },
      };

      const result = await runBenchmark({
        verifier,
        dataset,
        verifierName: "TestVerifier",
      });

      expect(result.verifierName).toBe("TestVerifier");
      expect(result.datasetSize).toBe(2);
      expect(result.accuracy).toBe(1);
      expect(result.predictions).toHaveLength(2);

      const summary = formatConsoleSummary(result);
      expect(summary).toContain("Factuality Benchmark Summary: TestVerifier");
      expect(summary).toContain("Accuracy:     100.00%");
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

      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });
});
