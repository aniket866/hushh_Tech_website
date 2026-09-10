# Supabase to Hushh Tech UAT Mapping

This report is derived from `migration/contracts/supabase-uat-mapping.v1.json`.
The Supabase project is source evidence only. UAT remains Firebase plus Cloud
Run, Cloud SQL, GCS, and approved GCP services.

## Totals

| Dependency type | Active | Mapped | Ready to map | Blocked | Not reachable or legacy |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tables | 17 | 0 | 11 | 6 | 0 |
| RPCs | 5 | 1 | 0 | 4 | 0 |
| Edge functions | 21 | 0 | 1 | 20 | 0 |
| Storage buckets | 2 | 0 | 0 | 2 | 0 |

The verifier reports `ACTIVE_UNMAPPED_COUNT = 0`. Explicit blockers are
acceptable; no active dependency is silently unclassified.

## Mapped

- `get_public_investor_profile` maps to `/api/public-investor-profile`, whose
  explicit projection is the approved public route.
- Firebase browser authentication maps to the `hushh-tech-uat` Firebase
  project. No active Supabase auth SDK path is used by the browser.

## Ready to Map

Tables: `user_enriched_profiles`, `investor_profiles`, `users`,
`ceo_meeting_payments`, `plaid_product_sync_statuses`, `onboarding_data`,
`onboarding_parties`, `onboarding_invites`, `user_financial_data`,
`nda_signatures`, `user_product_usage`.

Edge function: `investor-og-image` has a checked-in gateway contract, but exact
live UAT target proof is not present.

## Blockers

Tables: `hushh_ai_users`, `hushh_ai_chats`, `hushh_ai_messages`,
`hushh_ai_media_limits`, `identity_verifications`, `plaid_transfer_accounts`.

RPCs: `check_user_nda_status`, `sign_global_nda`, `track_product_usage`,
`increment_hushh_ai_uploads`.

Edge functions: `hushh-ai-chat`, `investor-chat`, `investor-agent-mcp`,
`kyc-agent-a2a`, `nda-signed-notification`, `nws-score-notification`,
`veo-generate-video`, `nda-admin-fetch`, `create-verification-session`,
`ceo-calendar-booking`, `coins-credit-notification`,
`coins-deduction-notification`, `fund-payment-admin-analytics`,
`fund-payment-admin-overview-list`, `fund-payment-admin-overview-metrics`,
`fund-payment-admin-detail`, `fund-payment-admin-crm`,
`fund-payment-admin-kyc-review`, `fund-payment-admin-kyc-screen`,
`fund-payment-admin-verify`.

Storage: `assets`, `hushh-ai-media`. Both are explicitly denied by the GCP
storage runtime until the target bucket, prefix, access mode, and serving
contract are attested.

## Runtime Safety

- No UAT runtime path adds `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, or a
  `VITE_SUPABASE_*` variable.
- Blocked tables, RPCs, and storage buckets are removed from the GCP runtime
  allowlists and return deterministic contract-blocked errors.
- No speculative Cloud SQL tables, data copy, identity mapping, or Edge
  Function enablement is included.
- The UAT Cloud SQL catalog remains only partially attested, so ready-to-map
  entries remain pending rather than being called mapped.

## Evidence

- `migration/contracts/source-inventory.v1.json`
- `migration/contracts/target-schema-offline-compile-evidence.v1.json`
- `migration/contracts/uat-cloudsql-readonly-attestation.v1.json`
- `migration/contracts/uat-schema-data-candidate-evidence.v2.json`
- `migration/manifests/supabase-retirement.v1.json`
- `migration/evidence/edge-function-terminal-matrix.v1.json`
- `migration/storage/supabase-storage-cutover.v1.json`
