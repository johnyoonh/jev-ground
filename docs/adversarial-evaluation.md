# Adversarial and metamorphic regression suite

This fixture originates in Jules PR #26. It contains **32 synthetic,
hand-labeled claims across five categories**: prompt injection in retrieved
evidence, conflicting/stale passages, semantic robustness, distractors,
and insufficiency-versus-contradiction distinctions. Four variants reference
a base case for metamorphic consistency checks (date swap, number swap,
distractor insertion, or evidence reorder).

These fixtures are **regression probes**, not a statistically representative
real-world benchmark. A high score with a mock oracle does **not** imply
Jev accuracy. No mock results are committed as live-model measurements.

## Offline dry run

~~~bash
npm ci && npm run build
npm run benchmark:adversarial
~~~

## Optional real Jev run

~~~bash
export TYPESAFE_API_KEY="..."
node scripts/run_adversarial.mjs \
  --verifier jev --model jev-1.13.0 \
  --max-examples 20 --live \
  --output data/reports/adversarial-jev.json
~~~

The paid run is explicit. Results contain the synthetic claim/evidence
and should not be published when using private datasets. The example
limit is not a provider-side spending cap.

The adapter uses the existing generic BenchmarkResult for confusion,
per-class precision/recall/F1, calibration and separate API failures.
It adds per-category accuracy/macro-F1 and checks metamorphic relations
only when both base and variant were evaluated successfully.
Incomplete pairs are marked **unscored**, not scored as failures.
Use a sufficiently large \`--max-examples\` to include the pairs.

The previous Jules mock report was intentionally excluded because its
reported numbers were obtained from fixture-specific heuristics, not
an independent model.
