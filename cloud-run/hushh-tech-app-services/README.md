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
  seams before parsing.
- Worker routes accept Google service identities only.
- Database work runs inside a transaction with transaction-local
  `app.firebase_uid`; pooled connections are reset before reuse.
- Readiness requires an exact per-service table privilege allowlist, forced
  row-level security on every accessible base table, and zero application
  object ownership by the runtime role or any role it can assume. Every table
  privilege allowlist is empty while all handlers remain disabled.
- Cloud SQL uses IAM database authentication over private IP. Password and
  connection-string configuration is rejected.

## Required environment

`SERVICE_OWNER`, `GOOGLE_CLOUD_PROJECT`, `SERVICE_AUDIENCE`,
`ALLOWED_GOOGLE_CALLERS`, `CLOUD_RUN_INGRESS_MODE`,
`PRIVATE_INGRESS_ENFORCED`, `FIREBASE_PROJECT_ID`, `PRODUCT_AUDIENCE`,
`PRODUCT_CLIENT_APP_ID`, `INSTANCE_CONNECTION_NAME`, `PGDATABASE`, and
`PGUSER` are mandatory and pinned to the selected UAT or production contract.

Run `npm run check` from this directory. Deployment is intentionally outside
this foundation change.
