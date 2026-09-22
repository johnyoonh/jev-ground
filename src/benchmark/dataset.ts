import fs from "node:fs/promises";
import type { Evidence, VerificationVerdict } from "../types.js";
import type { BenchmarkItem } from "./types.js";

const VALID_VERDICTS = new Set<VerificationVerdict>([
  "supported",
  "contradicted",
  "insufficient",
]);

export function validateBenchmarkItem(
  rawItem: unknown,
  lineIndex: number,
): BenchmarkItem {
  if (typeof rawItem !== "object" || rawItem === null) {
    throw new Error(
      `Invalid benchmark item at line ${lineIndex + 1}: expected an object`,
    );
  }

  const record = rawItem as Record<string, unknown>;

  if (typeof record.claim !== "string" || !record.claim.trim()) {
    throw new Error(
      `Invalid benchmark item at line ${
        lineIndex + 1
      }: 'claim' must be a non-empty string`,
    );
  }

  const goldVerdict = (
    record.goldVerdict ??
    record.gold_verdict ??
    record.verdict
  ) as VerificationVerdict;

  if (!VALID_VERDICTS.has(goldVerdict)) {
    throw new Error(
      `Invalid benchmark item at line ${
        lineIndex + 1
      }: 'goldVerdict' must be 'supported', 'contradicted', or 'insufficient', got: ${JSON.stringify(
        goldVerdict,
      )}`,
    );
  }

  let evidence: Evidence[] = [];
  if (Array.isArray(record.evidence)) {
    evidence = record.evidence.map((item, idx) => {
      if (typeof item === "string") {
        return { id: `evidence-${idx + 1}`, text: item };
      }
      if (typeof item === "object" && item !== null) {
        const itemObj = item as Record<string, unknown>;
        const text = typeof itemObj.text === "string" ? itemObj.text : "";
        const id =
          typeof itemObj.id === "string" ? itemObj.id : `evidence-${idx + 1}`;
        const metadata =
          typeof itemObj.metadata === "object" && itemObj.metadata !== null
            ? (itemObj.metadata as Record<string, unknown>)
            : undefined;
        return { id, text, ...(metadata ? { metadata } : {}) };
      }
      return { id: `evidence-${idx + 1}`, text: String(item) };
    });
  }

  const id =
    typeof record.id === "string" && record.id.trim()
      ? record.id
      : `item-${lineIndex + 1}`;

  const metadata =
    typeof record.metadata === "object" && record.metadata !== null
      ? (record.metadata as Record<string, unknown>)
      : undefined;

  return {
    id,
    claim: record.claim.trim(),
    evidence,
    goldVerdict,
    ...(metadata ? { metadata } : {}),
  };
}

export function parseJsonlDataset(jsonlContent: string): BenchmarkItem[] {
  const lines = jsonlContent.split("\n");
  const items: BenchmarkItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const parsed = JSON.parse(line);
      items.push(validateBenchmarkItem(parsed, i));
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("Invalid benchmark item")) {
        throw err;
      }
      throw new Error(
        `Failed to parse JSON on line ${i + 1}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return items;
}

export async function loadJsonlDataset(
  filePath: string,
): Promise<BenchmarkItem[]> {
  const content = await fs.readFile(filePath, "utf-8");
  return parseJsonlDataset(content);
}
