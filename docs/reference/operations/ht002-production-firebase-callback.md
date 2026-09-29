# HT-002: production Firebase callback CSP fix — partial authentication repair

Status: partial repair for review, not deployed; HT-002 remains open.

## Proven defect and scope

After Google provider consent returned to production `/auth/callback`, the
browser reported `auth/internal-error` and a CSP violation blocking
`https://apis.google.com/js/api.js`. Production's existing Firebase authDomain
also lacked its frame-src allowance. The runtime admits only
`https://apis.google.com` in script-src and
`https://hushh-tech-prod.firebaseapp.com` in frame-src when the request Host is
exactly `hushhtech.com` and both cloud and Firebase projects are
`hushh-tech-prod`. UAT's existing same-origin helper behavior is preserved.
No arbitrary origins, forwarded-host trust, auth provider changes, data enablement
or identity-mapping changes are introduced by this diff.

Regression tests compare the exact production CSP delta and unchanged response
and security headers, and reject mixed/missing project authority, attacker
suffixes, UAT host and spoofed forwarded-host headers. No existing tests removed.

The repository requires runtime byte locks to follow `server.js`. Its existing
repin tool recomputes three registry locks and matching digest constants.
These changes are hash-only consequences of this CSP patch, not activation or
new migration behavior. Historical reviewed_commit/reviewed_tree, trust anchors,
approval signatures and activation guards remain unchanged; independent
candidate re-review is still required. A digest update does not grant approval.

## Provider configuration already changed separately

On 2026-09-29, the explicitly approved existing Google OAuth client gained
`https://hushh-tech-prod.firebaseapp.com/__/auth/handler`. The existing Apple
Service ID gained domain `hushh-tech-prod.firebaseapp.com` and that return URL.
Final saves were reopened and persistence verified; all prior entries remained.
These console changes are not in this code diff and must not be repeated.
Google subsequently completed provider authorization and returned to the app.
Apple registration persistence is not proof of a completed Apple session.

## Validation and gaps

CI pins Node 20.19.0. A checksum-verified official Node 20.19.0 installation and
fresh `npm ci` were used for local checks; hosted Linux/container CI remains the
authoritative platform check. Ten auth files passed: 201 tests, 1 skipped.
Earlier 183-pass versus 178-pass reports used ten versus eight files. The latter
selection omitted 12 previously covered cases and added 7 CSP cases, hence
183 - 12 + 7 = 178. The current ten-file rerun restores all prior coverage and
also includes 11 new main-branch smoke tests: 183 + 7 + 11 = 201.

Node20 TypeScript, full build:web, env contract, lint hard gate and compact smoke
passed. Lint's full-repository report remains advisory; build reports large
chunks. Initial full-suite run found stale runtime hashes and concurrency
timeouts; the required locks were recomputed and the full suite rerun with two
workers, without changing timeouts or deleting tests. Final local full-suite result: 2,234 passed, 44 skipped, 5 timed out across
`gcpEdgeFunctionTerminalMatrix.test.ts` and `retirementCandidateClassifier.test.ts`.
The byte-lock failures are resolved; no green full-suite claim is made. Compact
smoke: 20 passed. Retirement, no-hybrid routes/source and npm audit regression
gates passed. Staged diff gitleaks found no secrets. Hosted check runs remain
required.

| Environment/provider | Evidence | Still required |
| --- | --- | --- |
| UAT / Google | Approved account completed consent in clean Chrome, reached financial-link, survived refresh | Protected account mapping/read, logout/relogin; in-app network-request-failed investigation |
| UAT / Apple | Existing provider and UAT registrations preserved | Real session, account read and full lifecycle |
| Production / Google | Provider consent/return passed; callback CSP failure reproduced | Deploy this partial fix, verify session/browser storage, restore account backend, full lifecycle |
| Production / Apple | Production domain/return saved and verified | Real provider exchange, session, account backend and full lifecycle |

Apple test account is now approved privately. Browser-native reconnection and
tab reconnection timed out; this is a tooling limit, not an application result.
Manual QA should use only approved accounts: inspect protected data responses
without copying Authorization headers, confirm the expected saved account and
destination, refresh, Log Out, then sign in again. Repeat separately for Apple,
including returning name/email absence and approved Hide My Email coverage.
In-app failure remains open; capture failed request host/path, status and error
category with tokens, query strings and private data omitted. Do not infer a
cause from Chrome success. Safari/storage regressions remain outstanding.

## Release boundary

Production was reverified at `hushh-tech-website-00223-xad`, commit
`b0ea737a6f531d4d5eb4b368684bd90ec086fb79`, 100% traffic. Pinned main base after the required freshness merge is
`2f3dc59270378f490c3f6f88715793bec079b6fd`. Normal review, CI, merge
queue and green-main policy remain required. Merge can trigger automatic UAT
deployment and its hosted test-user/NDA verification; merge is not authorized
by publishing this draft. Production dispatch requires its own approval and
exact landed green SHA. Do not deploy a feature SHA, add deployment tags or
assume a future merge SHA before it exists.

Main already contains intervening regulatory-content changes, generated
community content, a Nodemailer lockfile security update and Google smoke
coverage/workflow changes, plus KYC location/citizenship separation from the
required freshness merge. Maintainers must review the entire production-to-
candidate diff, not just this PR. If that scope cannot be approved, they must
select a supported hotfix procedure; no alternative lane is invented here.

Rollback target for an approved partial CSP release is the above production
revision at 100% traffic, preserving settings and the existing disabled data
flag. Provider-registration additions are separate; remove only those additions
if their rollback is specifically needed and approved. The CSP repair creates
no datastore and has only existing build/runtime usage costs.

Production `/api/gcp/data` independently returns 503 `GCP_DATA_DISABLED`.
The declared app SQL instance is absent; current data configuration and native
identity provisioning policies also hardcode UAT. The separate account-backend
proposal must establish production data ownership, exact schema/identity mapping,
runtime IAM/private connectivity and safe admission before activation. Never
enable the flag blindly, seed from UAT, merge by email or fabricate an empty
existing account. This PR cannot close HT-002.

## Final publication checks

Draft PR #2063 preserves the nine-file auth scope. Required main freshness
merge changes were verified with all ten auth files plus three KYC files:
216 passed, 1 skipped; TypeScript passed on Node 20.19.0. The two timeout-prone
files were also run alone with one worker: 41 passed and two classifier timeouts.
The untouched pinned main base, identical dependency lock and Node version,
produced the same 41 passes and same two timeouts. These persistent local
failures are not patch-only regressions; authoritative hosted gates remain
required and are not waived. No tests were removed or timeouts increased.

Hosted Node20 service, environment, retirement, security audit and secret-scan
steps passed on the preceding branch head; final-head status must come from
its own check run. Initial PR policy failed freshness, then exact requested
nonconventional title. The owner approved the policy-compliant `fix(auth):`
prefix; no policy code changed. This documentation update triggers normal
validation because the policy workflow does not run on PR title edits.

Browser tab connection recovered. Apple UAT returned to onboarding step3 and
survived refresh, but approved principal/provider attribution and protected-read
proof remain unverified. Native Chrome still times out accessing the isolated
Google session. Neither result completes the required lifecycle or closes HT-002.
