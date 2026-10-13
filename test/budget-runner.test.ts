import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runReliableBenchmark } from "../src/benchmark/reliable.js";
import { ProviderCallBudget } from "../src/resilience/budget.js";

function dataset(count: number) {
  return Array.from({length:count},(_,i)=>({
    id:"record-"+i, claim:"Claim "+i,
    evidence:[{id:"doc",text:"Claim "+i}],
    goldVerdict:"supported" as const,
  }));
}
function outcome(claim:string) {
  return {claim,verdict:"supported" as const,confidence:.9,evidenceIds:["doc"],
    probabilities:{supported:.9,contradicted:.05,insufficient:.05}};
}
describe("provider request budget in resumable benchmark", () => {
  it("stops launching cases at the hard cap, checkpoints and resumes successes", async () => {
    const dir=await mkdtemp(path.join(os.tmpdir(),"jev-budget-checkpoint-"));
    const checkpointPath=path.join(dir,"checkpoint.jsonl");
    const budget=new ProviderCallBudget({maxRequests:2});
    let actualCalls=0;
    const verifier={async verify({claim}:{claim:string}) {
      budget.reserve();
      actualCalls++;
      return outcome(claim);
    }};
    const opts={dataset:dataset(5),concurrency:1,checkpointPath,
      runFingerprint:"pinned-jev-v1-rubric-v2"};
    try {
      await expect(runReliableBenchmark({...opts,verifier}))
        .rejects.toThrow("provider request budget");
      expect(actualCalls).toBe(2);
      const journal=(await readFile(checkpointPath,"utf8")).trim().split("\n");
      expect(journal.length).toBe(4); // header, 2 successes, 1 blocked attempt
      const entries=journal.slice(1).map(s=>JSON.parse(s));
      expect(entries.filter(r=>r.prediction.verification).length).toBe(2);
      expect(entries.filter(r=>r.prediction.error).length).toBe(1);

      let resumedCalls=0;
      const next={async verify({claim}:{claim:string}) {
        resumedCalls++;
        return outcome(claim);
      }};
      const report=await runReliableBenchmark({...opts,verifier:next,resume:true});
      expect(report.resumed).toBe(2);
      expect(report.scored).toBe(5);
      expect(report.failed).toBe(0);
      expect(resumedCalls).toBe(3);
    } finally {
      await rm(dir,{recursive:true,force:true});
    }
  });
});
