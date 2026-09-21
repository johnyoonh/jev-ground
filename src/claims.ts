export type ClaimExtractor = (answer: string) => string[] | Promise<string[]>;

/**
 * Deliberately conservative v0.1 claim splitter.
 *
 * This is not intended to be a semantic/atomic claim extractor. It provides a
 * deterministic default so orchestration can be exercised without requiring a
 * second model. A pluggable semantic extractor is planned.
 */
export function splitClaims(answer: string): string[] {
  return answer
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/u)
    .map((claim) => claim.trim())
    .filter(Boolean);
}
