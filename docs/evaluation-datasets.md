# Evaluation datasets and reproducible runs

This repository distinguishes **claim + supplied evidence -> supported/contradicted/insufficient**
from binary *answer contains hallucinations* benchmarks. Do not relabel unsupported
answers as contradicted: contradiction and missing evidence are different.

## First run: AVeriTeC dev set

Dataset: [MichSchli/AVeriTeC](https://github.com/MichSchli/AVeriTeC),
license **CC BY-NC 4.0** (check suitability before commercial use).
Official records contain a claim, a gold fact-check label, and fact-checker
question/answer pairs. The importer maps:
- Supported -> supported
- Refuted -> contradicted
- Not Enough Evidence -> insufficient
- Conflicting Evidence/Cherry-picking -> **excluded**, not guessed

The importer sends question/answer pairs as evidence, NOT the gold justification,
fact-check article, or the labeled verdict. This is a **proxy factuality experiment**
because the original labels describe fact checks against the world, not a
gold entailment label for precisely the selected question/answer text.
Inspect a sample manually and report this limitation.

Prerequisites: merge the existing Jules benchmark PR #9 and CI PR #8,
then from repository root:

~~~bash
npm ci
npm run build
python3 scripts/prepare_eval.py averitec --download --split dev --balanced \
  --limit 60 --output data/normalized/averitec-dev-60.jsonl
python3 -m unittest discover -s test -p 'test_prepare_eval.py' -v

# Explicitly opt into paid requests; at most 20 benchmark examples by default.
export TYPESAFE_API_KEY="..."
node scripts/run_evaluation.mjs \
  --dataset data/normalized/averitec-dev-60.jsonl \
  --model jev-1.13.0 --max-examples 20 \
  --cache-dir .cache/jev-ground \
  --output data/reports/averitec-jev.json \
  --live
~~~

The manifest alongside the JSONL records source/output SHA-256, license,
seed, mapping/skipped counts, and whether the sample was class balanced.
The imported dataset stays under ignored `data/`; none of the source data
is redistributed as part of this repository. Review the upstream dataset
license before sharing generated artifacts.

## Second dataset: ContractNLI

Source: [Stanford ContractNLI](https://stanfordnlp.github.io/contract-nli/),
license **CC BY 4.0**, 607 contracts with 17 recurring hypotheses.
**Download from the official site after accepting its terms.** Locate its
labeled JSON file with top-level `documents` and `labels` and run:

~~~bash
python3 scripts/prepare_eval.py contract-nli \
  --input /path/to/contract-nli/dev.json --split dev --balanced --limit 60 \
  --max-evidence-chars 20000 \
  --output data/normalized/contract-nli-dev-60.jsonl

node scripts/run_evaluation.mjs \
  --dataset data/normalized/contract-nli-dev-60.jsonl \
  --max-examples 20 --cache-dir .cache/jev-ground \
  --output data/reports/contract-nli-jev.json --live
~~~

The converter maps Entailment -> supported, Contradiction -> contradicted,
NotMentioned -> insufficient. It uses **the entire contract as evidence**,
rather than selecting the human-annotated gold evidence spans; those span
indices stay in the result metadata for later attribution evaluation.
`--max-evidence-chars` **drops** overlong contracts instead of truncating
premises and silently corrupting gold labels. This selection changes the
population and must be reported. If your model supports full contracts,
omit that flag. Always test the model's context limits.

## Other datasets and why they need different evaluators

| Source | Labels/evidence | Follow-up |
| --- | --- | --- |
| [RAGBench](https://huggingface.co/datasets/galileo-ai/ragbench) | ~100k RAG examples; binary `adherence_score`, sentence-level support; CC BY 4.0 | Add a **binary response-level** or sentence-level task. Do not turn false adherence into 'contradicted'. |
| [HaluBench](https://huggingface.co/datasets/PatronusAI/HaluBench) | ~14,900 passage/question/answer samples; PASS/FAIL; CC BY-NC 2.0 | Implement binary faithful/unfaithful metrics and compare by `source_ds`. |
| [RAGTruth](https://github.com/ParticleMedia/RAGTruth) | ~18,000 RAG responses with hallucinated text spans | Span-aware evaluation of extracted atomic claims. |
| [FEVER](https://fever.ai/dataset/fever.html) | 185k+ SUPPORTS/REFUTES/NOT ENOUGH INFO claims | Join the separate Wikipedia sentence corpus to the claim's evidence references. The claims file alone does **not** contain passage text. |
| [AVeriTeC](https://github.com/MichSchli/AVeriTeC) | 4 fact-check verdicts | Three supported labels imported; conflicting label excluded. |
| [ContractNLI](https://stanfordnlp.github.io/contract-nli/) | 3 document entailment labels | Directly supported with official JSON downloaded separately. |

The 3-way verifier benchmark is not equivalent to a binary RAG answer-level
faithfulness benchmark. Scores across those tasks are not interchangeable.

## Caching and retry semantics

`CachedVerifier` wraps any `Verifier` and keys on SHA-256 of namespace,
claim, evidence IDs, evidence texts and evidence metadata. **Specify a
namespace that includes exact model name/version, verification rubric/prompt,
and provider behavior version.** Changing evidence or namespace invalidates
prior judgments. The file cache is opt-in; no credentials are written. Raw
provider responses are excluded from disk files, but **claim text, verdict,
and evidence IDs remain on disk**. Use the in-memory cache or `--no-cache`
for sensitive content. The `.cache/` directory is ignored.

`RetryingVerifier` retries only common transient HTTP statuses
(408, 409, 425, 429, 5xx including 529) and transient transport errors.
Authentication failures (401/403), validation errors, and other permanent
failures are not retried. The wrapper honors `Retry-After` within a maximum
backoff; retry count and delay are bounded. Failures are never cached.
Place the cache OUTSIDE the retry wrapper: cached -> retried -> provider.

Usage in your own TypeScript integration:

~~~ts
import {
  CachedVerifier, FileVerificationCache, JevVerifier, RetryingVerifier,
} from "jev-ground";

const verifier = new CachedVerifier(
  new RetryingVerifier(new JevVerifier(), { maxAttempts: 4 }),
  {
    namespace: "jev-latest:factuality-prompt-v1",
    cache: new FileVerificationCache(".cache/jev-ground"),
    ttlMs: 30 * 24 * 3600 * 1000,
  },
);
const result = await verifier.verify({ claim, evidence });
~~~

The live evaluator script defaults to an in-memory cache; provide
`--cache-dir .cache/jev-ground` to cache across runs. It requires `--live`.
It caps *examples* by default (20), **not total retries, input tokens, or
actual billing**. Set separate account/API-key billing limits before broad
runs. Verify TypeSafe model compatibility and API credentials yourself.
Accuracy from cached results is valid, but latency measured during cache
hits must be reported separately from uncached provider latency.

## Preflight and resumability

Live evaluation now performs exactly one uncached, representative model/schema
preflight before bulk work. Authentication or malformed Jev answers abort first.
The TypeSafe SDK built-in retries are disabled; RetryingVerifier is the only
retry owner. Concurrency is bounded (default 4; --concurrency configures it).

Runs write a private JSONL checkpoint at <output>.checkpoint.jsonl by default.
If interrupted, repeat the same command with --resume. The dataset, verifier
name, pinned model and rubric fingerprint must match. Successful cases are
reused without new API calls; previously failed cases are attempted again.
An uncached preflight still runs for the first unfinished case.

**Privacy:** checkpoints contain plaintext claim and evidence content. Store
them in an ignored/private directory. Do not publish checkpoint JSONL.
**Billing:** max-examples is not a hard provider-side dollar/token cap.

## Evaluation protocol

1. Verify a small dev sample manually; inspect class mappings and evidence.
2. Run a **balanced pilot** for coverage, then an unbalanced, held-out sample
   for realistic base rates. Fix seeds and store manifest SHA-256 values.
3. Measure all three classes' precision, recall, macro-F1, confusion matrix,
   failure rate, p50/p95 *uncached* latency, ECE/Brier, and cost per 1k
   uncached calls. Do not score failed provider calls as 'insufficient'.
4. Compare Jev, LLM, and cascades on **identical** examples/evidence.
5. Keep provider/version, prompt/rubric version, sampling policy,
   timeout/retry configuration, and cache-hit stats in the report.

The integrated benchmark reports basic precision/recall/F1 and latency.
Failed API calls are excluded from class metrics. More calibration and
cached/uncached latency work is still needed.
