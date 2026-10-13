import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { BatchVerifier, Verification, Verifier, VerifyClaimInput } from "../types.js";

export interface VerificationCacheEntry {
  storedAt: number;
  value: Verification;
}
export interface VerificationCache {
  get(key: string): Promise<VerificationCacheEntry | undefined>;
  set(key: string, entry: VerificationCacheEntry): Promise<void>;
}
/** No persistence: useful for tests or sensitive workloads. */
export class MemoryVerificationCache implements VerificationCache {
  private readonly entries = new Map<string, VerificationCacheEntry>();
  async get(key: string): Promise<VerificationCacheEntry | undefined> {
    return this.entries.get(key);
  }
  async set(key: string, entry: VerificationCacheEntry): Promise<void> {
    this.entries.set(key, entry);
  }
}
/** File persistence is explicit opt-in. Cache files can contain the original claim. */
export class FileVerificationCache implements VerificationCache {
  constructor(private readonly directory: string) {}
  private fileFor(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid cache key");
    return path.join(this.directory, key.slice(0, 2), key + ".json");
  }
  async get(key: string): Promise<VerificationCacheEntry | undefined> {
    try {
      const record: unknown = JSON.parse(await fs.readFile(this.fileFor(key), "utf8"));
      if (!isCacheEntry(record)) return undefined;
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }
  async set(key: string, entry: VerificationCacheEntry): Promise<void> {
    const file = this.fileFor(key);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + "." + randomUUID() + ".tmp";
    // Raw provider responses may contain sensitive content, so never persist raw by default.
    const { raw: _raw, cacheHit: _hit, ...safeValue } = entry.value;
    try {
      await fs.writeFile(temp, JSON.stringify({ storedAt: entry.storedAt, value: safeValue }),
        { mode: 0o600, flag: "wx" });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
}
function isCacheEntry(value: unknown): value is VerificationCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<VerificationCacheEntry>;
  const v = entry.value;
  if (typeof entry.storedAt !== "number" || !Number.isFinite(entry.storedAt) ||
      !v || typeof v !== "object" || typeof v.claim !== "string" ||
      !["supported", "contradicted", "insufficient"].includes(v.verdict) ||
      !Array.isArray(v.evidenceIds) || !v.evidenceIds.every((id) => typeof id === "string") ||
      typeof v.confidence !== "number" || !Number.isFinite(v.confidence)) return false;
  const p = v.probabilities;
  return !!p && [p.supported, p.contradicted, p.insufficient]
    .every(x => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1);
}
export function verificationCacheKey(namespace: string, input: VerifyClaimInput): string {
  if (!namespace.trim()) throw new Error("A stable namespace identifying model and prompt is required");
  const data = JSON.stringify({ schema: 1, namespace, claim: input.claim,
    evidence: input.evidence.map(e => ({ id: e.id, text: e.text, metadata: e.metadata })) });
  return createHash("sha256").update(data).digest("hex");
}
export interface CachedVerifierOptions {
  namespace: string; // MUST include model and policy/prompt version to avoid stale decisions
  cache: VerificationCache;
  ttlMs?: number;
  now?: () => number;
}
export class CachedVerifier implements BatchVerifier {
  readonly stats = { hits: 0, misses: 0, shared: 0, cacheErrors: 0 };
  private readonly pending = new Map<string, Promise<Verification>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(private readonly delegate: Verifier, private readonly options: CachedVerifierOptions) {
    verificationCacheKey(options.namespace, { claim: "", evidence: [] });
    this.ttlMs = options.ttlMs ?? Number.POSITIVE_INFINITY;
    if (this.ttlMs < 0 || Number.isNaN(this.ttlMs)) throw new RangeError("ttlMs must be nonnegative");
    this.now = options.now ?? Date.now;
  }
  async verify(input: VerifyClaimInput): Promise<Verification> {
    const key = verificationCacheKey(this.options.namespace, input);
    const inFlight = this.pending.get(key);
    if (inFlight) {
      this.stats.shared++;
      return inFlight;
    }
    const work = this.verifyOnce(key, input);
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }
  /**
   * Cache hits are reused; only cache misses are batched. Identical concurrent
   * single-claim lookups still coalesce through the same pending map.
   */
  async verifyMany(inputs: VerifyClaimInput[]): Promise<Verification[]> {
    if (inputs.length === 0) return [];
    const delegateBatch = (this.delegate as Partial<BatchVerifier>).verifyMany;
    if (typeof delegateBatch !== "function" || inputs.length === 1) {
      return Promise.all(inputs.map(input => this.verify(input)));
    }
    const keys = inputs.map(input => verificationCacheKey(this.options.namespace, input));
    if (new Set(keys).size !== keys.length || keys.some(key => this.pending.has(key))) {
      return Promise.all(inputs.map(input => this.verify(input)));
    }
    const outputs: Array<Verification | Promise<Verification>> = new Array(inputs.length);
    const misses: Array<{ key: string; input: VerifyClaimInput; index: number }> = [];
    for (let index = 0; index < inputs.length; index++) {
      const key = keys[index];
      let record: VerificationCacheEntry | undefined;
      try { record = await this.options.cache.get(key); }
      catch { this.stats.cacheErrors++; }
      if (record && this.now() - record.storedAt <= this.ttlMs) {
        this.stats.hits++;
        outputs[index] = { ...record.value, cacheHit: true };
      } else if (this.pending.has(key)) {
        this.stats.shared++;
        outputs[index] = this.pending.get(key)!;
      } else {
        this.stats.misses++;
        misses.push({ key, input: inputs[index], index });
      }
    }
    if (misses.length > 0) {
      const batch = (async () => {
        const verified = await delegateBatch.call(this.delegate, misses.map(item => item.input));
        if (verified.length !== misses.length ||
            verified.some((value, i) => !value || value.claim !== misses[i].input.claim)) {
          throw new Error("Batched delegate returned mismatched claim results");
        }
        await Promise.all(verified.map(async (value, index) => {
          try {
            await this.options.cache.set(misses[index].key, {
              storedAt: this.now(), value,
            });
          } catch { this.stats.cacheErrors++; }
        }));
        return verified.map(value => ({ ...value, cacheHit: false }));
      })();
      for (let i = 0; i < misses.length; i++) {
        const promise = batch.then(values => values[i]);
        const item = misses[i];
        this.pending.set(item.key, promise);
        outputs[item.index] = promise;
      }
      try {
        return await Promise.all(outputs);
      } finally {
        for (const item of misses) this.pending.delete(item.key);
      }
    }
    return Promise.all(outputs);
  }
  private async verifyOnce(key: string, input: VerifyClaimInput): Promise<Verification> {
    let record: VerificationCacheEntry | undefined;
    try { record = await this.options.cache.get(key); }
    catch { this.stats.cacheErrors++; }
    if (record && this.now() - record.storedAt <= this.ttlMs) {
      this.stats.hits++;
      return { ...record.value, cacheHit: true };
    }
    this.stats.misses++;
    const result = await this.delegate.verify(input);
    try { await this.options.cache.set(key, { storedAt: this.now(), value: result }); }
    catch { this.stats.cacheErrors++; }
    return { ...result, cacheHit: false };
  }
}
