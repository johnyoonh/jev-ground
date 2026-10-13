import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { PolicyDecision } from "./policy.js";
import type { VerificationProbabilities, VerificationVerdict } from "./types.js";

export interface DecisionTrace {
  requestId: string;
  correlationId?: string;
  claimHash: string;
  evidenceHashes: Array<{ id: string; hash: string }>;
  allowedEvidenceIds: string[];
  provider: string;
  model: string;
  rubricVersion: string;
  policyId: string;
  probabilities: VerificationProbabilities;
  policyDecision: PolicyDecision;
  reasons: string[];
  escalationPath: string;
  fallbackPath?: string;
  timestamp: string;
  durationMs: number;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  cost?: {
    estimatedCost?: number;
  };
  cacheHit: boolean;
  errorClass?: string | null;
  verdict?: VerificationVerdict;
  confidence?: number;
  /** Present ONLY when verbose/raw content opt-in is enabled */
  rawClaim?: string;
  /** Present ONLY when verbose/raw content opt-in is enabled */
  rawEvidence?: Array<{ id: string; text: string }>;
  metadata?: Record<string, unknown>;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const SECRET_KEY_PATTERN = /(api_?key|secret|password|token|auth|credential|jwt)/i;
const SECRET_VALUE_PATTERN = /^(ts_[a-zA-Z0-9_-]+|bearer\s+[a-zA-Z0-9_.-]+|sk-[a-zA-Z0-9_-]+)$/i;

export function redactSecrets<T>(data: T): T {
  if (data === null || data === undefined) return data;
  if (typeof data === "string") {
    if (SECRET_VALUE_PATTERN.test(data.trim())) {
      return "[REDACTED_SECRET]" as unknown as T;
    }
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => redactSecrets(item)) as unknown as T;
  }
  if (typeof data === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        redacted[key] = "[REDACTED_SECRET]";
      } else {
        redacted[key] = redactSecrets(value);
      }
    }
    return redacted as unknown as T;
  }
  return data;
}

export function exportTraceToJsonlLine(trace: DecisionTrace): string {
  const safeTrace = redactSecrets(trace);
  return JSON.stringify(safeTrace);
}

export function exportTracesToJsonl(traces: DecisionTrace[]): string {
  if (traces.length === 0) return "";
  return traces.map((t) => exportTraceToJsonlLine(t)).join("\n") + "\n";
}

export function parseJsonlTraces(jsonlContent: string): DecisionTrace[] {
  if (!jsonlContent.trim()) return [];
  const lines = jsonlContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const traces: DecisionTrace[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as DecisionTrace;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.requestId !== "string" ||
      typeof parsed.claimHash !== "string" ||
      !Array.isArray(parsed.evidenceHashes) ||
      !parsed.probabilities ||
      typeof parsed.policyDecision !== "string"
    ) {
      throw new Error("Invalid DecisionTrace line in JSONL");
    }
    traces.push(parsed);
  }
  return traces;
}

export function filterExpiredTraces(
  traces: DecisionTrace[],
  maxAgeMs: number,
  now = Date.now(),
): DecisionTrace[] {
  if (maxAgeMs <= 0 || !Number.isFinite(maxAgeMs)) return [...traces];
  return traces.filter((trace) => {
    const traceTime = new Date(trace.timestamp).getTime();
    if (Number.isNaN(traceTime)) return false;
    return now - traceTime <= maxAgeMs;
  });
}

export interface TraceSink {
  record(trace: DecisionTrace): Promise<void> | void;
}

export class MemoryTraceSink implements TraceSink {
  readonly traces: DecisionTrace[] = [];

  record(trace: DecisionTrace): void {
    this.traces.push(redactSecrets(trace));
  }

  clear(): void {
    this.traces.length = 0;
  }
}

export class FileTraceSink implements TraceSink {
  constructor(private readonly filePath: string) {}

  async record(trace: DecisionTrace): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const line = exportTraceToJsonlLine(trace) + "\n";
    await fs.appendFile(this.filePath, line, "utf8");
  }
}
