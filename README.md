# jev-ground

Evidence-grounded factuality verification for LLM and agent outputs.

`jev-ground` turns claims plus evidence into typed verification results:

- **supported**
- **contradicted**
- **insufficient**

The core is provider-independent. Jev/TypeSafe is the first provider, but the public API is designed so LLM, NLI, and cascade verifiers can be added without changing application code.

## Status

Early v0.1 scaffold. The first implementation focuses on:

- a small `Verifier` interface
- typed evidence and verification results
- a TypeSafe/Jev provider
- answer verification with simple deterministic claim splitting
- answer-level aggregation
- benchmark harness and evaluation layer for verifiers
- unit tests around provider-independent behavior

## Install

```bash
npm install
```

Set a TypeSafe API key for the Jev provider:

```bash
export TYPESAFE_API_KEY=ts_...
```

## Usage

```ts
import { JevVerifier, verifyAnswer } from "jev-ground";

const verifier = new JevVerifier();

const result = await verifyAnswer({
  answer: "Acme was incorporated in Delaware in May 2018. It launched in 2019.",
  evidence: [
    {
      id: "doc-17",
      text: "Acme was incorporated in Delaware in May 2018.",
    },
  ],
  verifier,
});

console.log(result.verdict);
console.log(result.claims);
```

## Benchmarking Factuality Verifiers

`jev-ground` includes a built-in evaluation harness to benchmark any `Verifier` against labeled datasets.

### Quickstart (Fixture Benchmark)

Run the benchmark fixture in one command:

```bash
npm run benchmark
```

You can also pass arguments to specify a dataset file, verifier, or save machine-readable JSON results:

```bash
# Benchmark Jev verifier against custom dataset
npm run benchmark -- --dataset ./my-dataset.jsonl --verifier jev --output ./benchmark-results.json
```

### JSONL Dataset Format

Bring your own labeled dataset as a JSONL file where each line is a JSON object matching this schema:

```json
{
  "id": "claim-001",
  "claim": "Acme Corp was incorporated in Delaware in May 2018.",
  "evidence": [
    {
      "id": "doc-101",
      "text": "Acme Corp was incorporated in Delaware in May 2018."
    }
  ],
  "goldVerdict": "supported",
  "metadata": {
    "domain": "finance",
    "source": "sec_filings"
  }
}
```

#### Fields

- `claim` (string, required): The statement to evaluate.
- `goldVerdict` (string, required): Ground truth verdict (`supported`, `contradicted`, or `insufficient`).
- `evidence` (array, optional): Array of evidence objects `{ id, text }` or array of raw string texts.
- `id` (string, optional): Unique sample identifier (auto-generated if omitted).
- `metadata` (object, optional): Arbitrary metadata key-values.

### Programmatic Benchmark Usage

You can benchmark any custom `Verifier` implementation programmatically:

```ts
import { runBenchmark, formatConsoleSummary } from "jev-ground";
import type { Verifier } from "jev-ground";

const myCustomVerifier: Verifier = {
  async verify({ claim, evidence }) {
    // Custom NLI model or LLM logic
    return {
      claim,
      verdict: "supported",
      probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
      confidence: 0.9,
      evidenceIds: evidence.map((e) => e.id),
    };
  },
};

const result = await runBenchmark({
  verifier: myCustomVerifier,
  dataset: "./my-labeled-dataset.jsonl",
  verifierName: "MyCustomModel",
  outputPath: "./results/my-model-eval.json",
});

// Console summary
console.log(formatConsoleSummary(result));

// Machine-readable metrics
console.log(`Accuracy: ${result.accuracy}`);
console.log(`Confusion Matrix:`, result.confusionMatrix);
console.log(`Latency (p95): ${result.latency.p95Ms} ms`);
```

### Metrics Reported

- **Accuracy**: Overall fraction of correct verdicts.
- **Precision, Recall, F1**: Computed per class (`supported`, `contradicted`, `insufficient`) plus macro-averages.
- **Confusion Matrix**: 3x3 matrix mapping `goldVerdict` against `predictedVerdict`.
- **Latency**: `totalMs`, `meanMs`, `medianMs`, `minMs`, `maxMs`, `p95Ms`.
- **Token & Cost Metadata**: Aggregate prompt tokens, completion tokens, total tokens, and total cost (when provided in `Verification.raw`).

## Design

The project deliberately separates orchestration from judgment:

```
answer
  -> claim extraction
  -> claim + evidence
  -> Verifier
  -> supported / contradicted / insufficient
  -> aggregate
```

This keeps Jev as a provider rather than making the repository a wrapper around one model.

## Development

```bash
npm test
npm run typecheck
npm run build
npm run benchmark
```

## License

MIT
