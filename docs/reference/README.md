# Reference Docs

This folder contains the tracked reference material used by the first-wave OSS contribution triage system.

## Index

1. [Operations Reference](./operations/README.md) for PR triage, decision buckets, CI governance, and skill taxonomy
2. [Quality Reference](./quality/README.md) for proof selection, patch-and-merge safety, and shared UI review
3. [API Contracts](./architecture/api-contracts.md) for backend route and page-to-API contract review
4. [Deep Intelligence API](./architecture/deep-intelligence-api.md) for the standalone Gemini Deep Research Cloud Run mirror
5. [GCP investor read-only function batch](./architecture/gcp-investor-read-only-function-batch.md) for two unreachable reviewed contracts, three deferred candidates, blockers, and live-verification gates

## Suggested order

1. Start with [Operations Reference](./operations/README.md) when the question is "what should we do with this PR?"
2. Use [Quality Reference](./quality/README.md) when the question becomes "what proof do we need?" or "is this safe to patch?"
3. Use [API Contracts](./architecture/api-contracts.md) when the PR changes request or response behavior, route semantics, or page-to-API expectations.
