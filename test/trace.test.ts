import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportTracesToJsonl,
  FileTraceSink,
  filterExpiredTraces,
  hashText,
  MemoryTraceSink,
  parseJsonlTraces,
  redactSecrets,
  type DecisionTrace,
} from "../src/trace.js";

const sampleTrace: DecisionTrace = {
  requestId: "req-123",
  claimHash: hashText("The earth is round."),
  evidenceHashes: [{ id: "doc-1", hash: hashText("The earth is round.") }],
  allowedEvidenceIds: ["doc-1"],
  provider: "jev",
  model: "jev-latest",
  rubricVersion: "1.0.0",
  policyId: "policy-v1",
  probabilities: { supported: 0.95, contradicted: 0.01, insufficient: 0.04 },
  policyDecision: "PASS",
  reasons: ["Supported prob >= 0.8"],
  escalationPath: "none",
  timestamp: new Date().toISOString(),
  durationMs: 42,
  cacheHit: false,
};

describe("trace and privacy", () => {
  it("computes deterministic SHA-256 hashes", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
    expect(hashText("hello")).not.toBe(hashText("world"));
    expect(hashText("hello")).toHaveLength(64);
  });

  it("redacts secret keys and tokens from objects", () => {
    const sensitiveObj = {
      user: "alice",
      apiKey: "ts_1234567890abcdef",
      auth: "Bearer eyJhbGciOi...",
      metadata: { secretToken: "sk-abcdef123456" },
    };
    const redacted = redactSecrets(sensitiveObj);
    expect(redacted.apiKey).toBe("[REDACTED_SECRET]");
    expect(redacted.auth).toBe("[REDACTED_SECRET]");
    expect(redacted.metadata.secretToken).toBe("[REDACTED_SECRET]");
    expect(redacted.user).toBe("alice");
  });

  it("exports and imports traces to/from JSONL without loss", () => {
    const jsonl = exportTracesToJsonl([sampleTrace]);
    expect(jsonl).toContain("req-123");
    expect(jsonl).not.toContain("\n\n");

    const parsed = parseJsonlTraces(jsonl);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].requestId).toBe("req-123");
    expect(parsed[0].claimHash).toBe(sampleTrace.claimHash);
  });

  it("filters expired traces according to maxAgeMs retention", () => {
    const now = Date.now();
    const freshTrace: DecisionTrace = {
      ...sampleTrace,
      requestId: "fresh",
      timestamp: new Date(now - 1000).toISOString(),
    };
    const oldTrace: DecisionTrace = {
      ...sampleTrace,
      requestId: "old",
      timestamp: new Date(now - 100000).toISOString(),
    };

    const active = filterExpiredTraces([freshTrace, oldTrace], 50000, now);
    expect(active).toHaveLength(1);
    expect(active[0].requestId).toBe("fresh");
  });

  it("persists traces using FileTraceSink", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "jev-trace-test-"));
    const filePath = path.join(tmpDir, "traces.jsonl");
    try {
      const sink = new FileTraceSink(filePath);
      await sink.record(sampleTrace);
      const content = await readFile(filePath, "utf8");
      expect(content).toContain("req-123");
      const parsed = parseJsonlTraces(content);
      expect(parsed).toHaveLength(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
