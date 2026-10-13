import type { VerifyClaimInput, Verification } from "./types.js";
import { isBatchVerifier } from "./types.js";

export interface ClaimBenchmarkResult {
  claimCount: number;
  baseline: {
    uncachedLatencyMs: number;
    cachedLatencyMs: number;
    calls: number;
    verdicts: string[];
  };
  batched: {
    uncachedLatencyMs: number;
    cachedLatencyMs: number;
    calls: number;
    verdicts: string[];
  };
  outcomeParity: boolean;
  callReductionRatio: number;
  speedupRatio: number;
}

export interface BatchBenchmarkReport {
  results: ClaimBenchmarkResult[];
  summary: {
    allParitiesMatch: boolean;
    totalBaselineCalls: number;
    totalBatchedCalls: number;
  };
}

export interface RunBatchBenchmarkOptions {
  claimCounts?: number[];
  mockDelayMs?: number;
}

class TrackingVerifier {
  calls = 0;
  constructor(
    private readonly handler: (inputs: VerifyClaimInput[]) => Promise<Verification[]>,
  ) {}

  async verify(input: VerifyClaimInput): Promise<Verification> {
    this.calls++;
    const [res] = await this.handler([input]);
    return res;
  }

  async verifyMany(inputs: VerifyClaimInput[]): Promise<Verification[]> {
    this.calls++;
    return this.handler(inputs);
  }
}

export function generateBenchmarkClaims(count: number): {
  evidence: { id: string; text: string }[];
  inputs: VerifyClaimInput[];
} {
  const evidence = [
    { id: "doc-1", text: "Acme Corporation was founded in 2010 in Delaware." },
    { id: "doc-2", text: "Acme released Product X in 2015 and Product Y in 2020." },
  ];

  const inputs: VerifyClaimInput[] = [];
  for (let i = 0; i < count; i++) {
    const isSupported = i % 2 === 0;
    const claim = isSupported
      ? `Claim ${i + 1}: Acme Corporation was founded in 2010.`
      : `Claim ${i + 1}: Acme Corporation was founded in 1990.`;
    inputs.push({ claim, evidence });
  }

  return { evidence, inputs };
}

export async function runBatchBenchmark(
  options: RunBatchBenchmarkOptions = {},
): Promise<BatchBenchmarkReport> {
  const claimCounts = options.claimCounts ?? [1, 5, 20];
  const mockDelayMs = options.mockDelayMs ?? 5;

  const results: ClaimBenchmarkResult[] = [];

  for (let count of claimCounts) {
    const { inputs } = generateBenchmarkClaims(count);

    // Simulated handler representing verifier work
    const handler = async (reqInputs: VerifyClaimInput[]): Promise<Verification[]> => {
      if (mockDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, mockDelayMs));
      }
      return reqInputs.map((input) => {
        const supported = input.claim.includes("2010");
        return {
          claim: input.claim,
          verdict: supported ? "supported" : "contradicted",
          probabilities: supported
            ? { supported: 0.9, contradicted: 0.05, insufficient: 0.05 }
            : { supported: 0.05, contradicted: 0.9, insufficient: 0.05 },
          confidence: 0.9,
          evidenceIds: input.evidence.map((e) => e.id),
          provider: "mock",
        };
      });
    };

    // 1. Baseline: one at a time
    const baselineTracker = new TrackingVerifier(handler);
    const startBaselineUncached = performance.now();
    const baselineVerifications = await Promise.all(
      inputs.map((inp) => baselineTracker.verify(inp)),
    );
    const baselineUncachedLatency = performance.now() - startBaselineUncached;
    const baselineCalls = baselineTracker.calls;

    // Simulated cached call for baseline
    const startBaselineCached = performance.now();
    await Promise.all(inputs.map((inp) => baselineTracker.verify(inp)));
    const baselineCachedLatency = performance.now() - startBaselineCached;

    // 2. Batched: verifyMany
    const batchedTracker = new TrackingVerifier(handler);
    const startBatchedUncached = performance.now();
    const batchedVerifications = await batchedTracker.verifyMany(inputs);
    const batchedUncachedLatency = performance.now() - startBatchedUncached;
    const batchedCalls = batchedTracker.calls;

    // Simulated cached call for batched
    const startBatchedCached = performance.now();
    await batchedTracker.verifyMany(inputs);
    const batchedCachedLatency = performance.now() - startBatchedCached;

    // Parity check
    const baselineVerdicts = baselineVerifications.map((v) => v.verdict);
    const batchedVerdicts = batchedVerifications.map((v) => v.verdict);
    const outcomeParity =
      baselineVerdicts.length === batchedVerdicts.length &&
      baselineVerdicts.every((v, idx) => v === batchedVerdicts[idx]);

    const callReductionRatio = baselineCalls / Math.max(1, batchedCalls);
    const speedupRatio =
      baselineUncachedLatency / Math.max(0.001, batchedUncachedLatency);

    results.push({
      claimCount: count,
      baseline: {
        uncachedLatencyMs: Math.round(baselineUncachedLatency * 100) / 100,
        cachedLatencyMs: Math.round(baselineCachedLatency * 100) / 100,
        calls: baselineCalls,
        verdicts: baselineVerdicts,
      },
      batched: {
        uncachedLatencyMs: Math.round(batchedUncachedLatency * 100) / 100,
        cachedLatencyMs: Math.round(batchedCachedLatency * 100) / 100,
        calls: batchedCalls,
        verdicts: batchedVerdicts,
      },
      outcomeParity,
      callReductionRatio: Math.round(callReductionRatio * 100) / 100,
      speedupRatio: Math.round(speedupRatio * 100) / 100,
    });
  }

  const allParitiesMatch = results.every((r) => r.outcomeParity);
  const totalBaselineCalls = results.reduce((acc, r) => acc + r.baseline.calls, 0);
  const totalBatchedCalls = results.reduce((acc, r) => acc + r.batched.calls, 0);

  return {
    results,
    summary: {
      allParitiesMatch,
      totalBaselineCalls,
      totalBatchedCalls,
    },
  };
}
