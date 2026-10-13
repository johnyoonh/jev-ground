import { describe, expect, it } from "vitest";
import { runBatchBenchmark } from "../src/benchmark/batching.js";
import { CachedVerifier, MemoryVerificationCache } from "../src/resilience/cache.js";
import type { BatchVerifier } from "../src/types.js";

describe("Jules batching request-count benchmark", () => {
  it("preserves verdict parity for 1, 5, 20 claims", async () => {
    const report = await runBatchBenchmark();
    expect(report.mode).toBe("synthetic-offline");
    expect(report.allParity).toBe(true);
    expect(report.results.map(r=>r.sequentialCalls)).toEqual([1,5,20]);
    expect(report.results.map(r=>r.batchedCalls)).toEqual([1,1,1]);
  });
  it("reuses cached claims while batching only fresh misses", async () => {
    let calls = 0;
    const delegate: BatchVerifier = {
      async verify(input) {return (await this.verifyMany([input]))[0];},
      async verifyMany(inputs) {
        calls++;
        return inputs.map(input=>({
          claim:input.claim,verdict:"supported" as const,
          probabilities:{supported:.9,contradicted:.05,insufficient:.05},
          confidence:.9,evidenceIds:input.evidence.map(e=>e.id),
        }));
      },
    };
    const cached = new CachedVerifier(delegate, {
      namespace:"test-pinned-v1",cache:new MemoryVerificationCache(),
    });
    const evidence=[{id:"doc",text:"Acme was founded in 2010."}];
    const a={claim:"Acme A",evidence}, b={claim:"Acme B",evidence};
    await cached.verify(a);
    const results=await cached.verifyMany([a,b]);
    expect(calls).toBe(2);
    expect(results.map(r=>r.cacheHit)).toEqual([true,false]);
  });
});
