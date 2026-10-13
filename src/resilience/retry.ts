import type { BatchVerifier, Verification, Verifier, VerifyClaimInput } from "../types.js";
import { isBatchVerifier } from "../types.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_CODE = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT",
]);
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown> : undefined;
}
function statusOf(error: unknown): number | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const value = record?.status ?? record?.statusCode ?? response?.status;
  return typeof value === "number" ? value : undefined;
}
function codeOf(error: unknown): string | undefined {
  const record = asRecord(error);
  const cause = asRecord(record?.cause);
  const code = record?.code ?? cause?.code;
  return typeof code === "string" ? code : undefined;
}
export function isTransientError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  const code = codeOf(error);
  return code !== undefined && RETRYABLE_CODE.has(code);
}
function retryAfterMs(error: unknown, nowMs: number): number | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const headers = record?.headers ?? response?.headers;
  const h = asRecord(headers);
  let value: unknown;
  if (h && typeof h.get === "function") {
    value = (h.get as (name: string) => unknown)("retry-after");
  } else {
    value = h?.["retry-after"] ?? h?.["Retry-After"];
  }
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const input = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(input)) return Math.max(0, Number(input) * 1000);
  const date = Date.parse(input);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
export class RetryingVerifier implements BatchVerifier {
  readonly stats = { calls: 0, attempts: 0, retries: 0 };
  private readonly options: Required<Pick<RetryOptions,
    "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "random" | "sleep" | "shouldRetry"
  >> & Pick<RetryOptions, "onRetry">;
  constructor(private readonly delegate: Verifier, options: RetryOptions = {}) {
    this.options = {
      maxAttempts: options.maxAttempts ?? 4,
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 8000,
      random: options.random ?? Math.random,
      sleep: options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms))),
      shouldRetry: options.shouldRetry ?? isTransientError,
      onRetry: options.onRetry,
    };
    if (!Number.isInteger(this.options.maxAttempts) || this.options.maxAttempts < 1 ||
        !Number.isFinite(this.options.baseDelayMs) || this.options.baseDelayMs < 0 ||
        !Number.isFinite(this.options.maxDelayMs) || this.options.maxDelayMs < 0 ||
        this.options.baseDelayMs > this.options.maxDelayMs) {
      throw new RangeError("Invalid retry policy");
    }
  }
  async verify(input: VerifyClaimInput): Promise<Verification> {
    this.stats.calls++;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      this.stats.attempts++;
      try {
        return await this.delegate.verify(input);
      } catch (error) {
        if (attempt === this.options.maxAttempts || !this.options.shouldRetry(error)) throw error;
        const exponential = Math.min(this.options.maxDelayMs,
          this.options.baseDelayMs * 2 ** (attempt - 1));
        const jitter = Math.max(0, Math.min(1, this.options.random()));
        const wait = Math.min(this.options.maxDelayMs,
          Math.max(exponential * (0.5 + 0.5 * jitter), retryAfterMs(error, Date.now()) ?? 0));
        this.stats.retries++;
        this.options.onRetry?.(error, attempt, wait);
        await this.options.sleep(wait);
      }
    }
    throw new Error("Unreachable retry state");
  }

  async verifyMany(inputs: VerifyClaimInput[]): Promise<Verification[]> {
    if (inputs.length === 0) return [];
    this.stats.calls++;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      this.stats.attempts++;
      try {
        if (isBatchVerifier(this.delegate)) {
          return await this.delegate.verifyMany(inputs);
        } else {
          return await Promise.all(
            inputs.map((input) => this.delegate.verify(input)),
          );
        }
      } catch (error) {
        if (attempt === this.options.maxAttempts || !this.options.shouldRetry(error)) throw error;
        const exponential = Math.min(this.options.maxDelayMs,
          this.options.baseDelayMs * 2 ** (attempt - 1));
        const jitter = Math.max(0, Math.min(1, this.options.random()));
        const wait = Math.min(this.options.maxDelayMs,
          Math.max(exponential * (0.5 + 0.5 * jitter), retryAfterMs(error, Date.now()) ?? 0));
        this.stats.retries++;
        this.options.onRetry?.(error, attempt, wait);
        await this.options.sleep(wait);
      }
    }
    throw new Error("Unreachable retry state");
  }
}
