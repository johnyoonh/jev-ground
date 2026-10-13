import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { Verification, Verifier, VerifyClaimInput } from "../types.js";

export interface VerificationCacheEntry {
  storedAt: number;
  value: Verification;
}

export interface PurgeOptions {
  /** Delete entries older than maxAgeMs relative to current time. */
  maxAgeMs?: number;
  /** Delete entries that have exceeded TTL. */
  expiredOnly?: boolean;
  /** TTL in milliseconds to determine expiration. */
  ttlMs?: number;
  /** Custom time provider. */
  now?: () => number;
}

export interface VerificationCache {
  get(key: string): Promise<VerificationCacheEntry | undefined>;
  set(key: string, entry: VerificationCacheEntry): Promise<void>;
  purge?(options?: PurgeOptions): Promise<number>;
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
  async purge(options: PurgeOptions = {}): Promise<number> {
    const now = options.now ? options.now() : Date.now();
    let count = 0;
    for (const [key, entry] of this.entries.entries()) {
      let remove = false;
      if (options.maxAgeMs !== undefined && now - entry.storedAt >= options.maxAgeMs) {
        remove = true;
      }
      if (options.expiredOnly && options.ttlMs !== undefined && now - entry.storedAt > options.ttlMs) {
        remove = true;
      }
      if (remove) {
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }
}

/**
 * File persistence is explicit opt-in.
 *
 * SECURITY WARNING & PLAINTEXT-AT-REST RISKS:
 * `FileVerificationCache` stores claims, verdicts, confidence scores, and evidence IDs in unencrypted
 * JSON files on disk. If claims or evidence contain sensitive information or PII, that content will
 * be stored in plaintext.
 *
 * Mitigations:
 * 1. Restrict filesystem access (this class creates directories with 0700 and files with 0600 mode).
 * 2. Use `noStore: true` on sensitive requests to bypass caching completely.
 * 3. Use `purge()` periodically or on application shutdown to clean up stale/expired cache entries.
 * 4. Raw provider responses are never written to disk by default.
 */
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

  /**
   * Purges cache files based on age or expiration criteria.
   * Returns the total number of cache files removed.
   */
  async purge(options: PurgeOptions = {}): Promise<number> {
    const now = options.now ? options.now() : Date.now();
    let removedCount = 0;

    let subdirs: string[];
    try {
      subdirs = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }

    for (const subdir of subdirs) {
      const subdirPath = path.join(this.directory, subdir);
      let files: string[];
      try {
        files = await fs.readdir(subdirPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(subdirPath, file);
        try {
          const contents = await fs.readFile(filePath, "utf8");
          const record = JSON.parse(contents);
          if (isCacheEntry(record)) {
            let remove = false;
            if (options.maxAgeMs !== undefined && now - record.storedAt >= options.maxAgeMs) {
              remove = true;
            }
            if (options.expiredOnly && options.ttlMs !== undefined && now - record.storedAt > options.ttlMs) {
              remove = true;
            }
            if (remove) {
              await fs.rm(filePath, { force: true });
              removedCount++;
            }
          }
        } catch {
          // Ignore parse or read error during purge
        }
      }

      // Try cleaning up empty subdirectories
      try {
        const remaining = await fs.readdir(subdirPath);
        if (remaining.length === 0) {
          await fs.rmdir(subdirPath);
        }
      } catch {
        // Ignore rmdir error
      }
    }

    return removedCount;
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
export class CachedVerifier implements Verifier {
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
  get isLocal(): boolean | undefined {
    return this.delegate.isLocal;
  }

  get provider(): string | undefined {
    return this.delegate.provider;
  }

  async verify(input: VerifyClaimInput): Promise<Verification> {
    if (input.noStore) {
      this.stats.misses++;
      const result = await this.delegate.verify(input);
      const { raw: _raw, ...safeResult } = result;
      return { ...safeResult, cacheHit: false };
    }

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
    if (!input.noStore) {
      try { await this.options.cache.set(key, { storedAt: this.now(), value: result }); }
      catch { this.stats.cacheErrors++; }
    }
    return { ...result, cacheHit: false };
  }
}
