import { describe, expect, it, vi } from "vitest";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { JevVerifier } from "../src/providers/jev.js";
import { ProviderCallBudget, ProviderBudgetExceededError } from "../src/resilience/budget.js";
import { CircuitBreakerVerifier, CircuitOpenError } from "../src/resilience/circuit.js";
import { RetryingVerifier } from "../src/resilience/retry.js";
import type { BatchVerifier, Verification, Verifier } from "../src/types.js";

const evidence = [{id:"e1",text:"Acme was established in 2018."}];
const sample = (claim = "Acme was established in 2018.") => ({claim,evidence});
const verified = (claim: string): Verification => ({
  claim, verdict:"supported", confidence:0.9, evidenceIds:["e1"],
  probabilities:{supported:0.9,contradicted:0.05,insufficient:0.05},
});
function response(req: {questions:Record<string,unknown>}) {
  const answers: Record<string,unknown> = {};
  for (const key of Object.keys(req.questions)) {
    answers[key] = key.startsWith("factuality")
      ? {type:"choice",choice:"supported",confidence:0.9,
          probabilities:{supported:0.9,contradicted:0.05,insufficient:0.05}}
      : {type:"noul",noul:0.95};
  }
  return {model:"jev-1.13.0",usage:{input_tokens:20,output_tokens:5},answers};
}
describe("P1 actual provider request budget", () => {
  it("reserves at most 5 requests, even with 10 concurrent workers", async () => {
    const budget = new ProviderCallBudget({maxRequests:5});
    const systemOne = vi.fn(async (request: {questions:Record<string,unknown>}) => response(request));
    const jev = new JevVerifier({
      client:{systemOne} as unknown as TypeSafeClient,
      model:"jev-1.13.0",
      beforeRequest:() => budget.reserve(),
    });
    const settled = await Promise.allSettled(
      Array.from({length:10},(_,i)=>jev.verify(sample("Acme claim "+i))),
    );
    expect(settled.filter(x=>x.status==="fulfilled")).toHaveLength(5);
    const rejected = settled.filter(x=>x.status==="rejected");
    expect(rejected).toHaveLength(5);
    expect(rejected.every(x=>x.reason instanceof ProviderBudgetExceededError)).toBe(true);
    expect(systemOne).toHaveBeenCalledTimes(5);
    expect(budget.snapshot.requestsReserved).toBe(5);
    expect(budget.snapshot.requestsRemaining).toBe(0);
  });

  it("counts transient retries and prevents one hidden extra attempt", async () => {
    const budget = new ProviderCallBudget({maxRequests:2});
    const systemOne = vi.fn(async () => { throw {status:429}; });
    const jev = new JevVerifier({
      client:{systemOne} as unknown as TypeSafeClient,
      beforeRequest:() => budget.reserve(),
    });
    const retry = new RetryingVerifier(jev,{
      maxAttempts:4,baseDelayMs:0,maxDelayMs:0,sleep:async()=>undefined,
    });
    await expect(retry.verify(sample())).rejects.toMatchObject({
      code:"PROVIDER_BUDGET_EXHAUSTED",reason:"requests",
    });
    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(retry.stats.attempts).toBe(3); // third attempt is stopped before SDK.
  });

  it("rejects missing estimate inputs and honors estimated cost/token and deadline", () => {
    const budget = new ProviderCallBudget({
      maxRequests:50,maxEstimatedTokens:100,maxEstimatedCostUsd:0.01,
    });
    expect(()=>budget.reserve()).toThrow("estimatedTokens required");
    budget.reserve({estimatedTokens:60,estimatedCostUsd:0.006});
    expect(()=>budget.reserve({estimatedTokens:50,estimatedCostUsd:0.005}))
      .toThrow(ProviderBudgetExceededError);
    expect(budget.snapshot.requestsReserved).toBe(1);
    expect(budget.snapshot.exhaustedReason).toBe("estimated_tokens");
    let now = 0;
    const deadline = new ProviderCallBudget({maxRequests:10,maxWallClockMs:100,now:()=>now});
    deadline.reserve();
    now = 100;
    expect(()=>deadline.reserve()).toThrow(ProviderBudgetExceededError);
    expect(deadline.snapshot.exhaustedReason).toBe("deadline");
  });

  it("keeps an independent reservation for each provider batch chunk", async () => {
    const budget = new ProviderCallBudget({maxRequests:2});
    const systemOne = vi.fn(async (request: {questions:Record<string,unknown>}) => response(request));
    const jev = new JevVerifier({
      client:{systemOne} as unknown as TypeSafeClient,
      maxQuestionsPerRequest:2, // one factuality + one evidence question per chunk
      beforeRequest:()=>budget.reserve(),
    });
    await expect(jev.verifyMany(Array.from({length:3},(_,i)=>sample("Claim "+i))))
      .rejects.toBeInstanceOf(ProviderBudgetExceededError);
    expect(systemOne).toHaveBeenCalledTimes(2);
  });
});

describe("P1 backend circuit breaker", () => {
  it("opens on transient exhaustion, blocks, then retries a single probe", async () => {
    let now = 0, calls = 0;
    let shouldFail = true;
    const delegate: Verifier = {async verify({claim}) {
      calls++;
      if(shouldFail)throw {status:503};
      return verified(claim);
    }};
    const breaker = new CircuitBreakerVerifier(delegate,{
      failureThreshold:2,cooldownMs:100,now:()=>now,
    });
    await expect(breaker.verify(sample())).rejects.toMatchObject({status:503});
    await expect(breaker.verify(sample())).rejects.toMatchObject({status:503});
    expect(breaker.state).toBe("open");
    await expect(breaker.verify(sample())).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(2);
    now = 101;
    await expect(breaker.verify(sample())).rejects.toMatchObject({status:503});
    expect(breaker.state).toBe("open");
    shouldFail=false;
    now=202;
    expect((await breaker.verify(sample())).verdict).toBe("supported");
    expect(breaker.state).toBe("closed");
    expect(calls).toBe(4);
    expect(breaker.stats.probes).toBe(2);
  });

  it("allows exactly one simultaneous half-open canary and preserves batch mode", async () => {
    let now = 0;
    let resolveProbe: ((value: Verification[])=>void)|undefined;
    let calls=0;
    const delegate: BatchVerifier = {
      async verify(input) {return (await this.verifyMany([input]))[0];},
      async verifyMany(inputs) {
        calls++;
        if(calls===1) throw {status:429};
        return new Promise<Verification[]>(resolve=>{resolveProbe=resolve;});
      },
    };
    const breaker = new CircuitBreakerVerifier(delegate,{
      failureThreshold:1,cooldownMs:100,now:()=>now,
    });
    await expect(breaker.verifyMany([sample()])).rejects.toMatchObject({status:429});
    now=101;
    const probe=breaker.verifyMany([sample("one"),sample("two")]);
    await expect(breaker.verify(sample("blocked"))).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(2);
    resolveProbe?.([verified("one"),verified("two")]);
    expect((await probe).map(x=>x.claim)).toEqual(["one","two"]);
    expect(breaker.state).toBe("closed");
  });

  it("does not open on schema, validation or budget exhaustion errors", async () => {
    const failures: unknown[] = [
      new Error("schema invalid"),
      new ProviderBudgetExceededError("requests"),
    ];
    let calls=0;
    const breaker = new CircuitBreakerVerifier({
      async verify() {calls++;throw failures[(calls-1)%2];},
    },{failureThreshold:1});
    await expect(breaker.verify(sample())).rejects.toThrow("schema invalid");
    await expect(breaker.verify(sample())).rejects.toBeInstanceOf(ProviderBudgetExceededError);
    expect(breaker.state).toBe("closed");
  });
});
