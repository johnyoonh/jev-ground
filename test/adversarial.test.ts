import { describe, expect, it } from "vitest";
import { loadAdversarialDataset, parseAdversarialJsonl, runAdversarialBenchmark } from "../src/benchmark/adversarial.js";

describe("Jules adversarial/metamorphic regression adapter", () => {
  it("loads the 32-case Jules corpus with categories and explicit metamorphic relations", async () => {
    const samples = await loadAdversarialDataset("data/benchmark/adversarial_metamorphic.jsonl");
    expect(samples).toHaveLength(32);
    expect(new Set(samples.map(x => x.category)).size).toBe(5);
    expect(samples.filter(x => x.metamorphic).length).toBe(4);
    expect(samples.filter(x => x.goldVerdict === "insufficient").length).toBeGreaterThan(0);
    expect(samples.filter(x => x.goldVerdict === "contradicted").length).toBeGreaterThan(0);
    expect(samples.filter(x => x.goldVerdict === "supported").length).toBeGreaterThan(0);
  });
  it("rejects malformed source rows and duplicate case identifiers", () => {
    expect(() => parseAdversarialJsonl("{invalid")).toThrow("Invalid JSON");
    const data = JSON.stringify({
      id: "a", claim: "A", evidence: [], goldVerdict: "supported", category: "test",
    });
    expect(() => parseAdversarialJsonl(data + "\n" + data)).toThrow("Duplicate");
  });
  it("uses the generic benchmark metrics, and does not count API errors as outcomes", async () => {
    const samples = [
      {id:"base",claim:"A",evidence:[{id:"doc",text:"A"}],
        goldVerdict:"supported" as const,category:"injection"},
      {id:"variant",claim:"B",evidence:[{id:"doc",text:"not B"}],
        goldVerdict:"contradicted" as const,category:"injection",
        metamorphic:{type:"number_swap",baseId:"base",expectedChange:"verdict_flip" as const}},
      {id:"failed",claim:"C",evidence:[{id:"doc",text:"C"}],
        goldVerdict:"insufficient" as const,category:"outage"},
    ];
    const verifier = { async verify({claim}:{claim:string}) {
      if(claim==="C")throw new Error("network");
      const verdict=claim==="A"?"supported" as const:"contradicted" as const;
      return { claim,verdict,confidence:.9,evidenceIds:[],probabilities:{
        supported:verdict==="supported"?.9:.05,
        contradicted:verdict==="contradicted"?.9:.05,
        insufficient:.05,
      }};
    }};
    const report=await runAdversarialBenchmark({dataset:samples,verifier});
    expect(report.benchmark.scored).toBe(2);
    expect(report.benchmark.failed).toBe(1);
    expect(report.categoryResults.injection.accuracy).toBe(1);
    expect(report.categoryResults.outage.accuracy).toBeNull();
    expect(report.scoredPairs).toBe(1);
    expect(report.passingPairs).toBe(1);
  });
});
