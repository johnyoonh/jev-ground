# Shadow-only policy evaluation and trace replay

The ShadowVerifier **does not block or rewrite responses**. It wraps a normal
Verifier and records a hypothetical policy decision alongside the original
classification. It is appropriate for collecting calibration evidence before
enforcing any PASS / REVIEW / FAIL policy.

**Do not treat default thresholds as calibrated or safe to enforce.** Confirm
their operating characteristics against held-out labeled data first.

## Basic usage

~~~ts
import {
  JevVerifier, ShadowVerifier, MemoryTraceSink,
  replayPolicy, comparePolicySnapshots,
} from "jev-ground";

const policy = { id: "trial-v1", rubricVersion: "v2" };
const sink = new MemoryTraceSink();
const shadow = new ShadowVerifier(new JevVerifier(), {
  policy, traceSink: sink,
});
const result = await shadow.verify({ claim: "Acme launched in 2018",
  evidence: [{ id: "doc-1", text: "Acme launched in 2018" }] });
// result is unchanged; inspect sink.traces for hypothetical decisions.
const alternate = { ...policy, id: "trial-strict", thresholds: {
  passSupportedThreshold: 0.95,
} };
const comparison = comparePolicySnapshots({
  traces: sink.traces, policyA: policy, policyB: alternate,
});
~~~

Provider failures produce error traces with no artificial probabilities and
REVIEW execution state; they must not be counted as insufficiency predictions.
Telemetry sink failures are best-effort and do not change verification output.

## Privacy

By default raw claim and evidence text are **not** stored. SHA-256 hashes and
evidence identifiers remain. **Hashes and IDs may still be sensitive or
linkable**; do not use them as an anonymization guarantee. Arbitrary custom
metadata is omitted by default. Verbose mode explicitly includes raw
claim/evidence and metadata and is unsuitable for confidential documents
without additional controls. Trace files are written with restrictive file
permissions on POSIX hosts. Store them under ignored private directories and
enforce retention externally.

## Replay correctness

Replay evaluates policy against stored *successful* verdict probabilities
without recalling the provider. Error traces remain review states. If gold
labels are available, the comparison reports false passes/false fails; when
labels are absent, it only reports decision transitions and newly passing
or nonpassing cases, not error-rate claims.
