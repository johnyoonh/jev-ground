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
      id: "doc-17",
      text: "Acme was incorporated in Delaware in May 2018.",
    },
  ],
  verifier,
});

console.log(result.verdict);
console.log(result.claims);
```

## Privacy, Egress Control & Sensitive Data

`jev-ground` provides explicit controls for handling sensitive evidence, PII, and egress restrictions:

### 1. Evidence Access Policy & Metadata
Evidence items accept an `access` level (`"public" | "sensitive" | "restricted"`):

```ts
const evidence = [
  {
    id: "doc-secret",
    text: "User SSN is 123-45-6789.",
    access: "restricted", // "public" | "sensitive" | "restricted"
  },
];
```

By default, **restricted** evidence is prohibited from remote network egress. If provided to a remote provider, execution is stopped with zero network calls and zero cache entries created, returning `executionState: "BLOCKED"`.

### 2. Application Egress Hook & Local Routing
You can supply custom egress policies or route restricted calls to a local verifier (`isLocal: true`):

```ts
import { EgressControlVerifier, verifyAnswer } from "jev-ground";

const verifier = new EgressControlVerifier(remoteVerifier, {
  localVerifier: myLocalVerifier,
  egressPolicy: async ({ claim, evidence }) => {
    // Custom egress rule
    return { action: "route-local", localVerifier: myLocalVerifier };
  },
});
```

### 3. Redaction & Evidence Minimization
Sensitive fields (e.g., SSNs, credit cards, emails, secret keys) can be automatically redacted before verification:

```ts
import { redactEvidence } from "jev-ground";

const { evidence: safeEvidence, transformed } = redactEvidence(evidence);
```

When evidence is redacted, `transformedEvidence: true` is set on the verification result to record that transformation occurred.

### 4. Per-Request `noStore` Option
Set `noStore: true` on any verification call to bypass memory and disk caches, suppress raw response persistence, and avoid debug logging:

```ts
const result = await verifyAnswer({
  answer: "Sensitive claim text...",
  evidence: sensitiveEvidence,
  verifier,
  noStore: true,
});
```

### 5. File Cache Purge & Plaintext-at-Rest Security Notice
> **Security Notice**: `FileVerificationCache` stores claims, verdicts, and evidence IDs as unencrypted JSON on disk (created with restricted `0700`/`0600` permissions). Raw provider responses are never persisted by default. To purge expired or aged cache entries:

```ts
const cache = new FileVerificationCache("/tmp/jev-cache");
const purgedCount = await cache.purge({ maxAgeMs: 24 * 60 * 60 * 1000 });
```

### Execution Priority Order
1. **Egress Restrictions / Privacy Policy (`EgressControlVerifier`)**: Enforces access policy prior to caching or network calls.
2. **Caching (`CachedVerifier`)**: Checked prior to provider calls (bypassed when `noStore: true`).
3. **Retries (`RetryingVerifier`)**: Retries transient network failures.
4. **Provider Execution**: Invokes live provider transport.

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
