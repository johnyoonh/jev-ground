import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyConfig } from "../src/policy.js";

const strictPolicy: PolicyConfig = {
  id: "strict-v1",
  rubricVersion: "1.0.0",
  thresholds: {
    failContradictedThreshold: 0.1,
    failInsufficientThreshold: 0.5,
    reviewContradictedThreshold: 0.02,
    reviewInsufficientThreshold: 0.1,
    passSupportedThreshold: 0.9,
  },
  escalationPaths: {
    FAIL: "block_immediately",
    REVIEW: "human_review",
    PASS: "allow",
  },
};

describe("evaluatePolicy", () => {
  it("evaluates to FAIL when contradicted probability exceeds threshold", () => {
    const result = evaluatePolicy(strictPolicy, {
      probabilities: { supported: 0.1, contradicted: 0.8, insufficient: 0.1 },
    });
    expect(result.decision).toBe("FAIL");
    expect(result.escalationPath).toBe("block_immediately");
    expect(result.reasons[0]).toContain("Contradicted probability");
  });

  it("evaluates to FAIL when verdict is contradicted", () => {
    const result = evaluatePolicy(strictPolicy, {
      probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
      verdict: "contradicted",
    });
    expect(result.decision).toBe("FAIL");
    expect(result.reasons[0]).toContain("Verdict is contradicted");
  });

  it("evaluates to REVIEW when contradicted/insufficient are within review limits", () => {
    const result = evaluatePolicy(strictPolicy, {
      probabilities: { supported: 0.85, contradicted: 0.03, insufficient: 0.12 },
    });
    expect(result.decision).toBe("REVIEW");
    expect(result.escalationPath).toBe("human_review");
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
  });

  it("evaluates to PASS when supported probability meets or exceeds threshold", () => {
    const result = evaluatePolicy(strictPolicy, {
      probabilities: { supported: 0.95, contradicted: 0.01, insufficient: 0.04 },
    });
    expect(result.decision).toBe("PASS");
    expect(result.escalationPath).toBe("allow");
  });
});
