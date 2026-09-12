# Hushh Tech UAT Cloud SQL catalog capture

This isolated package is a code-only, default-off Cloud Run Job candidate for
the missing UAT catalog proof. It has not been deployed or run against Google
Cloud. `CAPTURED` means only that the reviewed read-only query returned a safe,
sanitized envelope; it is not live proof or an attestation by itself.

## Locked boundary

| Field | Exact value |
| --- | --- |
| Environment | `uat` |
| Project | `hushh-tech-uat` |
| Region | `us-central1` |
| Instance | `hushh-tech-app-pg-uat` |
| Database | `hushh_tech_app` |
| PostgreSQL | 17 |
| Identity and Access Management database user | `hushh-tech-audit-uat@hushh-tech-uat.iam` |
| Cloud Run service account | `hushh-tech-audit-uat@hushh-tech-uat.iam.gserviceaccount.com` |
| Connector IP type | `PRIVATE` |
| Connector auth type | `IAM` |

Production and every other target fail before connector construction. All
libpq target, password, passfile, service file, certificate, database URL,
credential file, token, secret, and private-key environment inputs are rejected,
including empty values. The pool receives only the connector stream, exact user
and database, and a password callback that returns `undefined`; a real-driver
test proves this cannot fall through to `PGPASSFILE`.

## Default-off and immutable review gates

The container entry point is the hard supervisor. Its worker defaults to
`HUSHH_TECH_CLOUDSQL_ATTESTOR_EXECUTE=false`. With no environment values, the
worker validates local query/source/execution contracts, never imports the
connector or PostgreSQL driver, makes zero connector or network calls, and emits
one bounded `NOT_EXECUTED` line.

Future activation requires the literal `true` gate, all exact target labels,
and the exact reviewed execution-contract, query-set, and source hashes. It also
requires a syntactically immutable image-digest claim. That claim is not trusted
as the actual running image: an external reviewer must compare it with the Cloud
Run execution's Artifact Registry digest before accepting evidence. The reviewed
deployment helper is `npm run gcp:migration:deploy-cloudsql-attestor`: it defaults
to a plan, and `--activate-attestation --run-attestation` is the explicit
read-only activation path. It has no migration-apply option.

`src/anchors.js` is the explicitly reviewed trust-anchor file excluded from the
otherwise complete runtime source manifest to avoid a self-hash cycle. The
immutable image digest binds that file and the two self-describing contract
files copied into the image. `src/constants.js`, both SQL files, the supervisor,
verifier, runtime, schema, lockfile, and Docker build inputs are in the source
manifest.

## Read-only and time-bounded execution

One worker creates one connector and one pool connection. There is no
application retry loop. The Cloud SQL connector library may perform its own
transport retries; their count is deliberately reported as unknown rather than
zero. The hard supervisor terminates the entire worker with `SIGKILL` at 25
seconds, including connector internals and cleanup. The worker has a 22-second
abort deadline and two-second bounded cleanup calls.

The hash-bound programmatic contract contains exactly nine statements:

1. repeatable-read, read-only `BEGIN`;
2. five local limits/settings: 10-second statement timeout, one-second lock
   timeout, 15-second idle transaction timeout, `pg_catalog` search path, and
   4 MiB work memory;
3. one exact bounds query;
4. one exact catalog digest query;
5. `ROLLBACK`.

There is no commit path, write statement, temporary object, advisory lock,
`psql` meta command, or application retry. The bounds and digest statements run
inside the same snapshot. Each collection is capped at 10,000 rows and each
canonical row at 262,144 bytes before digest aggregation. The digest query
aggregates only fixed-size row hashes. Failures destroy the checked-out client;
pool and connector cleanup is attempted in `finally`, while the supervisor is
the final deadline if a library call cannot be cooperatively aborted.

The safe checks prove the exact database, PostgreSQL major version, current
audit user, read-only transaction, empty application catalog, expected role set,
safe role flags, and denial of temporary, database-create, schema-create,
privileged membership, object write, and inherited write-bearing default
privileges. Function defaults for the schema-owner and migration roles are
evaluated with PostgreSQL's effective `acldefault` value when no
`pg_default_acl` row exists, so implicit `PUBLIC EXECUTE` fails closed rather
than appearing absent. Only `hushh_tech_audit` and `pg_read_all_data` are permitted in the
audit user's recursive membership set, and both are still checked for effective
write capabilities. A failed check yields `BLOCKED`, never `CAPTURED`.

## Sanitized evidence and external verification

Raw catalog rows, definitions, access-control lists, object names, owner names,
membership names, system identifiers, private addresses, tokens, and connection
data never leave PostgreSQL as result fields and are never logged or persisted.
Only the 12 fixed collection labels, counts, canonical SHA-256 digests, safe
booleans, fixed target labels, fixed blocker codes, and reviewed hashes may be
emitted. Standard error is discarded by the supervisor. Standard output and
worker buffering are capped at 16 KiB.

`contracts/attestation-evidence.schema.json` is the exact deterministic consumer
seam. `captureSha256` and `evidenceSha256` detect an un-resealed modification but
are not signatures: anyone can recompute them. `src/verifier.js` therefore
requires trusted, external values for the actual image digest, service-identity
hash, Cloud Run execution hash, immutable log-entry hash, logged-evidence hash,
and every reviewed contract root. Only that second step returns
`CAPTURE_CONTEXT_VERIFIED`.

## Local verification only

```bash
npm ci --ignore-scripts
npm run check
npm test
npm audit --omit=dev --audit-level=low
docker build --platform=linux/amd64 .
```

Local tests use injected fakes, the actual pinned PostgreSQL driver without
connecting, and an optional disposable local PostgreSQL 17 container. They do
not contact Cloud SQL, Google APIs, Supabase, or GitHub. A green local run is not
live catalog proof.
