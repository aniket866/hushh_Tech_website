# Hushh Tech application services

One fail-closed Node.js image serves seven locked Cloud Run owners through
`SERVICE_OWNER`:

- `investor-api`
- `identity-api`
- `financial-api`
- `content-api`
- `engagement-api-worker`
- `signed-webhook-service`
- `worker`

The image embeds the frozen 112-function retirement registry. No legacy
Only `hushh-location-geocode` is enabled by this foundation. The other 110
runtime entries remain `INVENTORY_FROZEN`; 111 are replacement candidates,
and the retired secret-disclosure function has no handler.
Unknown, wrong-owner, retired, unverified, and unimplemented routes fail
closed.

`hushh-location-geocode` is wired only on the private investor service.
`stock-quotes` is the first wired GCP candidate, but it does not enable the
legacy compatibility route. Its separate private path,
`/api/v1/public/stock-quotes`, is default-off, belongs only to `investor-api`,
accepts only the pinned website runtime identity, and requires both process-local
and Firestore transaction-backed per-client and provider-wide limits before
the provider handler can run. The provider-wide default permits two 27-symbol
fan-outs per minute across all service instances.
The public website candidate is the same-origin `/api/stock-quotes` route. It
accepts exactly the trusted two-address load-balancer forwarding contract and
sends only a server-salted HMAC client key to the private service. It never
forwards a raw client address, browser credential, or CORS header. The existing
browser hook remains unchanged until live readiness is proven. Enabling is
blocked until the website Cloud Run service is verified as
`internal-and-cloud-load-balancing`, its default URL rejects public traffic,
the external load balancer produces the exact two-address forwarding header,
and hosted tests prove spoofed chains and direct `run.app` requests fail.

`get-locations`, `hushh-dob-inference`, and `investor-og-image` remain
unimplemented and frozen behind licensing, privacy, and public-media contract
blockers. The source map, exact wire behavior, blockers, and live-verification
checklist are documented in
`docs/reference/architecture/gcp-investor-read-only-function-batch.md`. All 112
legacy registry entries, including `stock-quotes`, remain
`INVENTORY_FROZEN`.

## Runtime boundary

- Cloud Run ingress and Invoker IAM remain infrastructure controls. Readiness
  also requires an explicit private-ingress contract.
- Every compatibility or private candidate request requires a Google-signed
  caller token.
- User-facing and webhook services accept only the checked-in
  `hushh-tech-web-{stage}` caller. The worker accepts only the
  checked-in `hushh-tech-task-runner-{stage}` caller.
- User routes then reverify the forwarded, product-bound Firebase token with
  revocation checking.
- Webhooks retain exact raw bytes and require one of six explicit verifier
  seams before parsing. A handler can run only after a durable ledger atomically
  moves the SHA-256 provider/event key and exact-payload hash into a leased
  `PROCESSING` state. Success must atomically persist `COMPLETED` plus the
  idempotent outbox; failure becomes `RETRYABLE`, and a completed duplicate gets
  a no-op success without running the handler. Webhook handlers receive no
  direct database transaction, so every durable effect must be emitted through
  that outbox. No production ledger adapter is installed by this foundation.
- Worker routes accept Google service identities only.
- Every ported route requires the checked-in Firestore transaction-backed
  shared rate limiter. It stores only hashed bucket keys, fixed-window counts,
  and expiry timestamps in one dedicated Firestore database per service owner.
  Each runtime identity is conditionally authorized only for its own database;
  a compromised service cannot read or alter another service's limits.
  Readiness proves both read and write access, while the process-local limiter
  remains a secondary bound. Enabling a route also requires the `expires_at`
  Firestore time-to-live policy, the exact no-index field contract, and
  database-scoped runtime service-account access to be live-verified.
  Readiness returns unavailable after five seconds; a deterministic,
  time-to-live-bound readiness marker already queued by Firestore may still
  complete, but no application handler runs.
- A bounded request deadline aborts disconnected or timed-out work and is
  passed to handlers. The database statement timeout must remain strictly below
  that deadline, and aborted transactions cannot commit.
- A limiter increment already accepted by Firestore may complete after the
  caller disconnects. It stores only a hashed bucket key and consumes one
  conservative budget token; the handler and application database work remain
  aborted.
- Database work runs inside a transaction with transaction-local
  `app.firebase_uid`; pooled connections are reset before reuse.
- Readiness requires exact per-service table, column, and sequence privilege
  allowlists, no grant options or database temporary-table privilege, forced
  row-level security on every table reachable through table or column grants,
  and zero application object ownership by the runtime role or any role it can
  assume. Every privilege allowlist stays empty; the stock quote candidate has
  no database facade.
- Cloud SQL uses IAM database authentication over private IP. Password and
  connection-string configuration is rejected.

## Required environment

`SERVICE_OWNER`, `GOOGLE_CLOUD_PROJECT`, `SERVICE_AUDIENCE`,
`ALLOWED_GOOGLE_CALLERS`, `CLOUD_RUN_INGRESS_MODE`,
`PRIVATE_INGRESS_ENFORCED`, `FIREBASE_PROJECT_ID`, `PRODUCT_AUDIENCE`,
`PRODUCT_CLIENT_APP_ID`, `INSTANCE_CONNECTION_NAME`, `PGDATABASE`, and
`PGUSER` are mandatory and pinned to the selected UAT or production contract.

The stock candidate additionally requires
`HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED=true`, a server-only
`FINNHUB_API_KEY`, and the bounded `PUBLIC_STOCK_QUOTES_RATE_LIMIT`,
`PUBLIC_STOCK_QUOTES_PROVIDER_REQUESTS_PER_MINUTE`, and
`FINNHUB_QUOTE_TIMEOUT_MS` settings. The website gateway separately requires
the exact `HUSHH_TECH_INVESTOR_API_URL` for its project and a server-only
`HUSHH_TECH_PUBLIC_RATE_LIMIT_SALT`. Missing or drifted values fail closed.

Run `npm run check` from this directory. The image uses a digest-pinned Node 22
base and defaults to the Cloud Run `linux/amd64` platform:

```bash
docker build --platform linux/amd64 \
  --provenance=false \
  -t hushh-tech-app-services:local .
```

Deployment is intentionally outside this foundation change.
