import fs from "node:fs";
import path from "node:path";
import { JevVerifier } from "../providers/jev.js";
import type { VerificationVerdict, Verifier, VerifyClaimInput } from "../types.js";
import { formatConsoleSummary, runBenchmark } from "./runner.js";

export class MockVerifier implements Verifier {
  async verify({ claim, evidence }: VerifyClaimInput) {
    const combinedEvidence = evidence.map((e) => e.text).join(" ").toLowerCase();
    const lowerClaim = claim.toLowerCase();

    let verdict: VerificationVerdict = "insufficient";

    // Simple heuristic for synthetic benchmark fixture tests
    if (
      lowerClaim.includes("founded in 2020") &&
      combinedEvidence.includes("founded in 2018")
    ) {
      verdict = "contradicted";
    } else if (
      lowerClaim.includes("founded in 2018") &&
      combinedEvidence.includes("founded in 2018")
    ) {
      verdict = "supported";
    } else if (
      lowerClaim.includes("delaware") &&
      combinedEvidence.includes("delaware")
    ) {
      verdict = "supported";
    } else if (
      lowerClaim.includes("headquarters") &&
      !combinedEvidence.includes("headquarters")
    ) {
      verdict = "insufficient";
    } else if (
      combinedEvidence.length > 0 &&
      lowerClaim.split(" ").some((word) => word.length > 4 && combinedEvidence.includes(word))
    ) {
      verdict = "supported";
    }

    return {
      claim,
      verdict,
      probabilities: {
        supported: verdict === "supported" ? 0.9 : 0.05,
        contradicted: verdict === "contradicted" ? 0.9 : 0.05,
        insufficient: verdict === "insufficient" ? 0.9 : 0.05,
      },
      confidence: 0.9,
      evidenceIds: evidence.map((e) => e.id),
      provider: "mock",
    };
  }
}

function parseArgs(args: string[]) {
  const options: {
    dataset: string;
    output?: string;
    verifierType: "mock" | "jev";
    help?: boolean;
  } = {
    dataset: "fixtures/benchmark-fixture.jsonl",
    verifierType: "mock",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dataset" || arg === "-d") {
      options.dataset = args[++i];
    } else if (arg === "--output" || arg === "-o") {
      options.output = args[++i];
    } else if (arg === "--verifier" || arg === "-v") {
      const v = args[++i];
      if (v === "jev" || v === "mock") {
        options.verifierType = v;
      } else {
        throw new Error(`Unknown verifier type: ${v}. Choose 'mock' or 'jev'.`);
      }
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
jev-ground Benchmark Runner

Usage:
  node dist/benchmark/cli.js [options]

Options:
  -d, --dataset <path>   Path to JSONL dataset file (default: fixtures/benchmark-fixture.jsonl)
  -o, --output <path>    Path to save output JSON results
  -v, --verifier <type>  Verifier to benchmark: 'mock' or 'jev' (default: mock)
  -h, --help             Show this help message
`);
}

export async function main() {
  try {
    const args = process.argv.slice(2);
    const options = parseArgs(args);

    if (options.help) {
      printHelp();
      return;
    }

    let datasetPath = options.dataset;
    if (!fs.existsSync(datasetPath)) {
      // Fallback relative to project root if running from dist
      const rootFallback = path.resolve(process.cwd(), datasetPath);
      if (fs.existsSync(rootFallback)) {
        datasetPath = rootFallback;
      } else {
        throw new Error(`Dataset file not found at path: ${options.dataset}`);
      }
    }

    let verifier: Verifier;
    let verifierName: string;

    if (options.verifierType === "jev") {
      verifier = new JevVerifier();
      verifierName = "JevVerifier";
    } else {
      verifier = new MockVerifier();
      verifierName = "MockVerifier";
    }

    const result = await runBenchmark({
      verifier,
      dataset: datasetPath,
      verifierName,
      outputPath: options.output,
    });

    console.log(formatConsoleSummary(result));

    if (options.output) {
      console.log(`Results persisted to: ${options.output}`);
    } else {
      // Output JSON to console if stdout piping requested
      console.log("\n--- Machine-Readable Output (JSON) ---");
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err: unknown) {
    console.error(`Benchmark error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"))) {
  main();
}
