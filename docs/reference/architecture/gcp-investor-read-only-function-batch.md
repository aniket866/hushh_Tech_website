# GCP investor read-only function batch

This document records the first reviewed Hushh Tech function candidates. It is
code-readiness evidence only, not deployment or parity evidence.

## Safety state

- All 112 registry entries remain `INVENTORY_FROZEN`.
- The default Cloud Run server supplies an empty handler map.
- The same-origin gateway checks the frozen registry before its staged contract
  map, so every route returns `FUNCTION_NOT_MIGRATED` before a handler lookup.
- Ten candidates have compiled contracts. Eight new GCP-only candidate
  handlers and adapters remain deliberately absent from runtime wiring.
- `hushh-dob-inference` remains unimplemented.
- The new runtime modules contain no source-system package, URL, environment
  name, software development kit, database client, storage client, or fallback.
- No Google Cloud Platform (GCP) or source-system resource was changed.

## Source evidence

The checked-in source and sanitized live-bundle evidence were compared. The
eight-candidate source and live-bundle digests, plus exact request, table,
column, cache, side-effect, dependency, and blocker contracts, are recorded in
`cloud-run/hushh-tech-app-services/registry/candidates.gcp-read-batch.v1.json`.

| Slug | Version | Checked-in source SHA-256 | Live source SHA-256 | Live bundle digest |
| --- | ---: | --- | --- | --- |
| `hushh-location-geocode` | 6092 | `499a6dd0f528045f5285ebe794a2d0c798c83ee31dccb4533682530f8d4f1573` | `6aaf6aaa0141e4949d911e3a3e53c12e0454dd427e9d6bf5599ef2b72a2f6e90` | `7f408b67193781383b2ca67c01e99501b9ab9da041ac8afb843382a45bd4ac8f` |
| `stock-quotes` | 6285 | `2bcc1476769fbf46bb330556761e60a4a0a90a1a9f4a97c3ec0eba4a7a9ef68b` | `86abf4fe66472a7a1d87e34c156768591944c0a00d3c064939ee4d055b2bafc4` | `d54c9bcc4c8b642c9a16650e72878a9a70724dad7ce7d8f998e94e0241932683` |

The live bundle inventory is
`migration/evidence/supabase-live-function-bundles.v1.json`. No recovered
temporary path or recovered source is committed.

## Shared route and authentication

The compatibility path remains `/functions/v1/{slug}`. After a future
per-slug parity approval, the same-origin web gateway will require a
product-bound Firebase bearer token, obtain a Google identity token, and call
the private investor service at `/api/v1/legacy-functions/{slug}`. The service
reverifies the exact Google caller and Firebase token, including revocation and
Hushh Tech product binding.

The gateway deadline is 25 seconds. The service deadline is 20 seconds. Both
network adapters receive the service abort signal. The service independently
enforces the exact per-function byte limit before JSON parsing, even though the
gateway applies the same limit.

## Intentional security exceptions from source behavior

The target contracts deliberately fail closed more strictly than the source.
These are expected security differences, not proven parity:

- non-allowlisted methods return 405 instead of entering source parsing or
  provider logic;
- unknown or duplicate query parameters return 400 instead of being ignored;
- a non-JSON media type returns 415 before parsing;
- malformed JSON returns a typed 400. The source geocoder could return a 500,
  while the source stock handler could silently continue with its fixed list.

Before either function can move to `PORTED_AND_VERIFIED`, normalized A/B
evidence must record each difference as expected, prove that no supported
client depends on the old behavior, and receive security and product approval.
An unexplained difference still blocks the registry flip.

## Implemented but unreachable contracts

### `hushh-location-geocode`

- Method and path: `POST /functions/v1/hushh-location-geocode`; no subpath or
  query; required JSON body; maximum 16,384 request bytes at both boundaries.
- Body: `latitude` and `longitude`; numeric strings retain legacy coercion.
- Latitude must be within `[-90, 90]`; longitude must be within `[-180, 180]`.
  Values outside Earth coordinate bounds return the existing invalid-coordinate
  400 response without contacting a provider.
- Success: `{ "success": true, "data": { country, countryCode, state,
  stateCode, city, postalCode, phoneDialCode, timezone, formattedAddress,
  latitude, longitude } }`.
- Missing coordinates, invalid coordinates, and provider failure preserve the
  existing response status and body shapes.
- Cache: `private, no-store`.
- Adapter: Google Maps when an explicit server-only key is provided, followed
  by Nominatim. Both calls reject redirects and receive the abort signal.

### `stock-quotes`

- Method and path: `GET` or `POST /functions/v1/stock-quotes`; no subpath or
  query. POST accepts optional JSON up to 8,192 request bytes at both
  boundaries.
- Success: `{ "success": true, "quotes": [...], "fetchedAt", "count" }`.
  Individual provider failures are omitted; missing provider configuration and
  handler failures preserve the existing 500 shapes.
- Cache: `private, no-store`.
- Adapter: Finnhub through an injected server-only key, ten-symbol batches, two
  200 millisecond inter-batch delays, redirect rejection, and abort propagation.
- Known source behavior: a caller `symbols` list is parsed but ignored while
  the fixed 27-symbol watchlist is fetched. This remains unchanged until live
  parity and product review approve a correction.

## Additional implemented but unreachable candidates

### `get-locations`

The source implementation depends on a GPL-3.0 package. That package and its
transitive data are absent from the service package and lockfile. The candidate
uses only a generation- and SHA-256-pinned Cloud Storage JSON catalog. It stays
frozen until that licensed artifact is staged and public caller auth parity is
resolved.

### `chat-check-access`

The transactional Cloud SQL adapter serializes each visitor/profile pair,
creates the free token once, and resets paid hourly counters without storing
network address or user-agent data. It stays frozen because
`chat_access_tokens` is absent from the target table manifest and public caller
auth parity is unresolved.

### Fund-admin reads

The analytics, overview, list, and metrics candidates require a verified
Firebase claim whose `fund_admin` value is the literal boolean `true`. They use
static Cloud SQL statements, bounded pagination, best-effort audit writes, and
degrade only the optional KYC source. They stay frozen until exact grants,
forced row-level security, real claim issuance, and private live UAT parity are
proven. `kyc_attestations` is absent from the target manifest.

### `generate-investor-profile`

The candidate uses Vertex AI in `us-central1`, validates every option in the
12-field schema, and returns sanitized provider failures. It stays frozen until
Vertex IAM, quota, and private live UAT parity are proven.

### `investor-og-image`

The GCP handler queries only confirmed public rows and XML-escapes every dynamic
SVG value. Its source behavior is public media, while the current compatibility
gateway requires a Firebase bearer token. It remains frozen until public
routing, abuse controls, cache behavior, and live row-visibility proof exist.

## Explicitly deferred candidate

### `hushh-dob-inference`

This function has no GCP contract, adapter, prompt, parser, fallback, or
handler. Inferring a date of birth from public search results or name patterns
is a privacy-sensitive product decision. It remains frozen until privacy,
legal, safety, and product owners define permissible evidence, retention,
confidence, user notice, correction, and no-result behavior.

## Automated proof

The focused Node suite proves:

- the real registry remains 112 of 112 frozen and the default server has no
  handlers;
- exactly ten reviewed contracts compile, including the eight-candidate batch;
- exact method, path, query, media type, cache, Firebase authentication,
  16,384-byte and 8,192-byte service limits, and abort behavior;
- coordinate boundaries fail before provider access;
- Google-to-Nominatim behavior, Finnhub projection, fixed stock batches, and
  exact success and error shapes;
- no candidate handler executes while the real registry remains frozen;
- each of the eight gateway paths returns 503 before Firebase auth or upstream
  access, and strict admin, PII, catalog-integrity, SVG-injection, Cloud SQL,
  pagination, and Vertex-schema adversarial cases pass.

Run:

```bash
cd cloud-run/hushh-tech-app-services
npm run check
```

The gateway contract test is in `tests/gcpFunctionGateway.test.ts`.

## Enablement blockers

1. UAT has no deployed revision containing the two handlers.
2. The default server intentionally has no handler or adapter wiring.
3. The distributed rate-limit adapter is unavailable.
4. Google Maps and Finnhub secrets are not bound.
5. Provider quotas, error bodies, cache behavior, latency, Firebase failures,
   and normalized response hashes have not been verified against live UAT.
6. The fixed stock watchlist differs from the caller-provided list.
7. The machine matrix records the remaining table, claim, licensing, Vertex,
   public-auth, and public-media blockers for each candidate.

## Live verification checklist

- Keep all five registry entries frozen during review and testing.
- Deploy an exact reviewed SHA to an unserved UAT revision with zero traffic.
- Install the distributed limiter before readiness can pass.
- Bind only the reviewed service identities and provider secrets.
- Prove missing, revoked, wrong-audience, wrong-product, and wrong-user tokens
  never reach either handler.
- Replay the exact method and body matrix for geocoding and stock quotes against
  source and GCP; compare status, media type, normalized body hash, and cache.
- Run valid, invalid, boundary, malformed-JSON, 8,192-byte, 8,193-byte,
  16,384-byte, 16,385-byte, disconnect, and deadline probes.
- Verify geocoder normal, Google failure, Nominatim failure, coordinate-bound,
  redirect, and quota paths without logging locations or credentials.
- Verify all fixed 27 quote symbols, partial failures, rate timing, and provider
  quota paths without logging credentials.
- Verify browser and server egress contains no legacy hostname, credential
  name, software development kit call, database call, storage call, or fallback.
- Do not stage the location catalog without a permissive complete dataset.
- Do not implement DOB inference without recorded privacy approval.
- Do not route OG media through the Firebase compatibility gateway; approve a
  separate public media contract first.
- Keep every registry entry frozen until the required UAT request count has zero
  unexplained differences and an independent reviewer approves one exact slug.
