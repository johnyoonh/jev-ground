# Claim-to-evidence citation attribution

Jules PR #7 contributed dedicated attribution tests and a README example.
The current verifier asks separate Jev relevance questions for the supplied
evidence IDs while evaluating each atomic claim. It rejects or filters
unknown evidence IDs from the answer results, rather than treating every
supplied document as supporting evidence.

~~~ts
const result = await verifyAnswer({ answer, evidence, verifier });
for (const claim of result.claims) {
  console.log(claim.claim, claim.verdict, claim.evidenceIds);
}
~~~

Caveats: \`evidenceIds\` identify **relevant evidence items**, not source
spans, exact quotations, or independently verified citations. With
\`insufficient\` verdicts, the default Jev provider emits an empty ID list,
even if evidence is suggestive but inconclusive. Unsupported claims must
not be "rescued" by hallucinated IDs. Live attribution quality still needs
an independently labeled citation benchmark.

The tests preserved from Jules's PR verify a relevant chunk among
distractors, an insufficient verdict, and filtering of fabricated IDs.
