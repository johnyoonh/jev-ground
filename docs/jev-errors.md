# Typed Jev response diagnostics

Jules PR #23 inspired preserving a **classification reason** on malformed
provider answers without losing the correct retry behavior.

`InvalidJevResponseError` retains the public `code:
"JEV_RESPONSE_INVALID"` and adds one of these `reason` values:

- `MISSING_ANSWER`: an expected per-claim or attribution answer is absent
- `INVALID_RESPONSE`: the envelope, response type or confidence is invalid
- `MALFORMED_PROBABILITIES`: incomplete, nonfinite, out-of-range or
  unnormalized three-way probabilities
- `LABEL_MISMATCH`: chosen factuality class disagrees with the distribution

Network/API exceptions are **not** wrapped as model-format errors. That
allows `RetryingVerifier` to retry genuine HTTP 429/5xx and transient
transport failures while never retrying a malformed model response.

`JEV_RUBRIC_FINGERPRINT` and `getJevCacheNamespace(model,
fingerprint?)` make cache/prompt revisions explicit. Use a pinned
model version for durable cache validity, not a mutable model alias.

These checks do not certify statistical calibration; they only reject
malformed output.
