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
function is enabled by this foundation: all 112 entries remain
`INVENTORY_FROZEN`; 111 are replacement candidates, and the retired
secret-disclosure function has no handler.
Unknown, wrong-owner, retired, unverified, and unimplemented routes fail
closed.

## Runtime boundary

- Cloud Run ingress and Invoker IAM remain infrastructure controls. Readiness
  also requires an explicit private-ingress contract.
- Every compatibility request requires a Google-signed caller token.
- User-facing and webhook services accept only the checked-in
  `hushh-tech-web-gateway-{stage}` caller. The worker accepts only the
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
- Every ported route requires a shared rate-limit adapter. The process-local
  limiter is only a secondary bound; the production default fails closed until
  a reviewed distributed adapter is installed.
- A bounded request deadline aborts disconnected or timed-out work and is
  passed to handlers. The database statement timeout must remain strictly below
  that deadline, and aborted transactions cannot commit.
- Database work runs inside a transaction with transaction-local
  `app.firebase_uid`; pooled connections are reset before reuse.
- Readiness requires exact per-service table, column, and sequence privilege
  allowlists, no grant options or database temporary-table privilege, forced
  row-level security on every table reachable through table or column grants,
  and zero application object ownership by the runtime role or any role it can
  assume. Every privilege allowlist is empty while all handlers remain
  disabled.
- Cloud SQL uses IAM database authentication over private IP. Password and
  connection-string configuration is rejected.

## Required environment

`SERVICE_OWNER`, `GOOGLE_CLOUD_PROJECT`, `SERVICE_AUDIENCE`,
`ALLOWED_GOOGLE_CALLERS`, `CLOUD_RUN_INGRESS_MODE`,
`PRIVATE_INGRESS_ENFORCED`, `FIREBASE_PROJECT_ID`, `PRODUCT_AUDIENCE`,
`PRODUCT_CLIENT_APP_ID`, `INSTANCE_CONNECTION_NAME`, `PGDATABASE`, and
`PGUSER` are mandatory and pinned to the selected UAT or production contract.

Run `npm run check` from this directory. The image uses a digest-pinned Node 22
base and defaults to the Cloud Run `linux/amd64` platform:

```bash
docker build --platform linux/amd64 \
  --provenance=false \
  -t hushh-tech-app-services:local .
```

Deployment is intentionally outside this foundation change.
