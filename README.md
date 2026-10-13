# jev-ground

[![CI](https://github.com/typesafe-ai/jev-ground/actions/workflows/ci.yml/badge.svg)](https://github.com/typesafe-ai/jev-ground/actions/workflows/ci.yml)

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
      id: "doc-17",
      text: "Acme was incorporated in Delaware in May 2018.",
    },
  ],
  verifier,
});

console.log(result.verdict);
console.log(result.claims);
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
