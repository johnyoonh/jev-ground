# Synthetic batching comparison

This harness preserves the request-count and verdict-parity experiment proposed
in Jules PR #25, but does **not** simulate cached hits or claim synthetic wall
times predict Jev API performance. It uses a deterministic offline handler.

~~~bash
npm ci && npm run benchmark:batching
~~~

Expected request counts for 1, 5 and 20 claims sharing evidence are 1/1,
5/1 and 20/1 (separate/batched). This is a *test of orchestration shape*,
not measured Jev cost or p95 latency. A live head-to-head comparison must
use a pinned model, the same evidence/questions and an account-side spending
limit. The provider's batched request uses one independently typed factuality
question per claim and additional evidence-attribution questions.
