# API Contracts

This document maps the current Hushhtech API contract surfaces that matter during OSS contribution triage.

## Main API surfaces

### Public and page-facing routes

1. `api/public-investor-profile.js`
2. `api/google-wallet-pass.js`
3. `api/wallet-pass.js`
4. `api/delete-account.js`
5. `api/career-application.js`

### Metrics and analytics routes

1. `api/metrics/summary.js`
2. `api/metrics/send-report.js`
3. `api/analytics/realtime.js`
4. `api/analytics/collect.js`

### Shared runtime helpers

1. `api/shared/walletPassModel.js`
2. `api/metrics/service.js`
3. `server.js`

### Standalone Cloud Run services

1. `cloud-run/deep-intelligence-api`

The Deep Intelligence API is a separate consent-gated Gemini Deep Research
service. Its full contract and safety boundary live in
`docs/reference/architecture/deep-intelligence-api.md`.

### Hushh Research UAT client

The default-off Hushh Research product connector uses same-origin routes under
`/api/hushh-research/*`. Its Firebase, PKCE, compatibility, connector-key, and
rollback contracts live in
[`hushh-research-uat-client.md`](./hushh-research-uat-client.md).

## Contract rules

1. Treat any browser page and its backing API route as one behavior contract.
2. If a PR changes request shape, response shape, env assumptions, or error behavior, it is an API contract change.
3. `backend-api-contracts` should own the routing decision for small contract corrections during patch-and-merge review.
4. `security-audit` must be consulted if the route change touches auth, secrets, privileged data, or fail-closed behavior.

## Analytics contract

- `GET /api/metrics/summary?window_days=7` is the single public analytics payload for the dashboard. It returns safe aggregates only: business funnel, GA4 traffic, first-party audience/search/activity/funnel/dropoff, Google Search Console search performance, GCP Cloud Run metrics, legacy appendix, data coverage, and warnings.
- `POST /api/analytics/collect` is the website ingestion route. It accepts sanitized batched events, derives authenticated `user_id` only from a server-validated Supabase bearer token, hashes visitor/session identifiers, and writes raw rows with the Supabase service role.
- Public analytics responses must not include raw event rows, user IDs, emails, IP addresses, full user agents, OAuth/Stripe/Supabase tokens, raw search text, chat prompts, Plaid data, or small identifying cells.
- Public Search Console query/page rows must be fixed top-N aggregates only, not caller-selected arbitrary dimensions. Page URLs must strip query/hash and canonicalize dynamic IDs/slugs. Query rows require stricter public thresholds than product analytics and must suppress suspicious email/token-like labels.
