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
      id: "doc-1",
      text: "Acme is headquartered in San Francisco with 100 employees.",
    },
    {
      id: "doc-17",
      text: "Acme was incorporated in Delaware in May 2018.",
    },
  ],
  verifier,
});

console.log(result.verdict); // "insufficient" (since 2019 launch is ungrounded)

// Print individual claim results with attributed evidence citations
for (const claim of result.claims) {
  console.log(`Claim: "${claim.claim}"`);
  console.log(`  Verdict: ${claim.verdict}`);
  console.log(`  Citations (evidenceIds): ${claim.evidenceIds.join(", ") || "none"}`);
}
```

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
```

## License

MIT
