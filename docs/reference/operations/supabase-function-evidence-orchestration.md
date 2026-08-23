# Supabase Function Evidence Orchestration

This local-only contract composes two frozen, read-only function captures without
re-capturing data or changing either upstream evidence artifact:

- traffic evidence at `2026-08-21T16:00:00.000Z`, with version deltas
  `{0: 16, 40: 96}`;
- current bundle evidence captured from `2026-08-21T17:52:04.388Z` through
  `2026-08-21T18:03:38.344Z`, with version deltas `{0: 16, 43: 96}`.

The exact same 16-function set matches the retirement manifest in both
snapshots. The exact same 96-function set is drifted in both snapshots. That is
recorded as
`CONTINUOUS_VERSION_DRIFT_OBSERVED_BETWEEN_FROZEN_CAPTURES`, limited to the two
bound snapshot timestamps. It does not prove behavior between those timestamps.

The contract does not claim a source revision, Git SHA, deployment event, or
deployment cause. The supported provider surfaces do not prove those values.

Cutover remains blocked because:

- all 112 functions remain `INVENTORY_FROZEN` and zero are ported and verified;
- 17 traffic entries still have cutover-blocking source contracts;
- 16 current bundle downloads ended in provider HTTP 500 retrieval failures;
- the current bundle capture did not perform a closing metadata check.

The public orchestration artifact contains only paths, hashes, counts,
timestamps, status labels, and fixed commit identifiers. It contains no raw
logs, source bundles, request data, credentials, or provider response bodies.

Validate it locally with:

```bash
npm run migration:function-evidence:check
```

The checker reads only fixed repository paths. It independently runs the
retirement, historical bundle, traffic, and current bundle validators; verifies
their exact file hashes; reconciles all 112 function identifiers and auth flags;
and enforces the frozen cutover blockers. It performs no network, database,
deployment, or provider operation.
