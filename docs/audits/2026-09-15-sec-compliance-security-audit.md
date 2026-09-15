# HushhTech Website — SEC, Offering, Privacy, and Security Readiness Audit

**Audit date:** 15 September 2026<br>
**Repository:** `hushh-labs/hushh_Tech_website`<br>
**Commit reviewed:** `b0ea737a6f531d4d5eb4b368684bd90ec086fb79`<br>
**Public environments reviewed:** `https://hushhtech.com` and `https://uat.hushhtech.com`<br>
**Overall decision:** **RED — NO-GO for public investment marketing, solicitation, onboarding, or payment until the P0 controls are closed and securities counsel signs off.**

> This is an independent technical and compliance-readiness assessment, not an SEC examination, legal opinion, registration determination, penetration test, or certification of compliance. Securities counsel and the designated compliance officer must determine the final legal position for each entity, offering, jurisdiction, and communication.

## 1. Executive conclusion

The current website creates material regulatory and investor-protection risk. The most serious items are not presentation defects:

- Hushh publicly states that it and/or Fund A are “SEC Registered,” but Hushh does not appear under the reviewed names in the SEC's current registered-investment-adviser or exempt-reporting-adviser rosters, and no Hushh filing was found in EDGAR. Management has also stated that Hushh is not currently SEC registered.
- The public site presents Fund A as having a **+21.4% net FY 2025 return**, while the March 2026 PPM says the fund is newly formed, has no operating history, and has not implemented the strategy in a live fund. Delaware records show the named Fund A LP was formed on 26 March 2026.
- The public marketing page says the offering uses Rule 506(c), while the confidential PPM says Rule 506(b). A publicly accessible website can constitute general solicitation, which is incompatible with a 506(b) offering unless counsel establishes a compliant pre-existing substantive relationship and removes public solicitation.
- Documents explicitly marked confidential and/or describing a 506(b) private offering are available anonymously, indexed in public discovery files, and returned with public caching. The NDA gate therefore does not protect the actual offering package.
- The application can collect a $1 “fund payment” and move a user into review without executing the Subscription Agreement or LPA, obtaining the PPM-required tax/source-of-funds package, or performing reliable accredited-investor/qualified-purchaser verification. An administrator can override a missing/high-risk KYC record.
- Social Security numbers and entity tax IDs are stored in plaintext despite field names and UI language that imply secure/encrypted storage.

This combination could support allegations of misleading statements, an invalid offering process, inadequate privacy/safeguards, and deficient books-and-records controls. The correct immediate response is evidence preservation, controlled takedown, counsel review, and workflow suspension—not adding a longer footer disclaimer.

### Finding count

| Priority | Count | Meaning |
|---|---:|---|
| P0 / Critical | 6 | Stop the affected public activity or data collection immediately |
| P1 / High | 13 | Must close before relaunch or investor acceptance |
| P2 / Medium | 10 | Required hardening and governance work |
| P3 / Low | 3 | Quality, consistency, and defensibility improvements |
| **Total** | **32** | One coordinated remediation program |

## 2. Required action in the first 24 hours

Preserve the current evidence before removal: production/UAT HTML, documents, API responses, screenshots, deployment revisions, source commit, approval records, access logs, analytics, payment records, and the dates each statement was published. Do not alter or delete relevant records.

- [ ] **Suspend public investment solicitation and the Fund A payment/onboarding CTA.** Keep non-investment corporate content online only if it does not make an offer or unsupported claim.
- [ ] **Remove every “SEC Registered,” “SEC-registered investment adviser,” “registered investment vehicle,” and “Fully SEC compliant” statement** from production, UAT, metadata, images, generated content, emails, and social/community content pending written legal approval tied to an exact legal entity and CRD/file number.
- [ ] **Remove or quarantine the +21.4% FY 2025 return, daily Fund A NAV/history, target-return graphics, and predecessor-account results** until a qualified independent performance review establishes ownership, calculation methodology, period, fees, cash flows, model/backtest status, portability, and compliant disclosure.
- [ ] **Block anonymous access to all PPMs, prospectuses, LPAs, subscription documents, suitability questionnaires, wire instructions, investor letters, and confidential decks/posts.** Purge CDN/search caches and remove them from sitemap, robots, `llms.txt`, generated static content, and public object storage.
- [ ] **Disable the $1 fund-payment/coupon path and administrator approval override** until the subscription, investor-verification, KYC/AML, tax, source-of-funds, sanctions, document-version, and GP-acceptance gates are server-enforced.
- [ ] **Stop new SSN/EIN collection into plaintext fields.** Restrict access, investigate exposure, establish deletion/retention requirements, and migrate to a tokenized or application-layer envelope-encrypted design using managed KMS/HSM controls.
- [ ] Appoint securities counsel and one accountable compliance owner to approve the offering exemption, entities, eligibility standard, offering package, marketing policy, performance policy, and relaunch decision in writing.
- [ ] Treat already-public confidential documents and exposed embedded credentials as security/privacy incidents: scope access, rotate credentials, document decisions, and apply notification rules if triggered.

## 3. Critical findings (P0)

### C-01 — Unsupported and apparently false SEC-registration branding

**Evidence.** The site says “SEC Registered,” “SEC Registered Fund,” “registered investment vehicle,” “SEC-registered investment adviser,” and “Fully SEC compliant.” Examples include:

- `src/components/Footer.tsx:210`
- `src/pages/home/ui.tsx:1123`
- `src/components/Hero.tsx:298`
- `src/pages/profile/ui.tsx:132`
- `src/pages/onboarding/step-7/ui.tsx:401-405`
- `src/content/posts/nda/operatingAgreement.tsx:64`
- `src/pages/discover-fund-a/logic.ts:179`

The SEC's 1 September 2026 current RIA and ERA downloads contain no match for “Hushh,” “Hushh Technologies,” “Hushh Advisory,” or “Alpha Aloha.” EDGAR searches for the reviewed names returned no filing. The user separately confirmed the company is not SEC registered.

**Risk.** A disclaimer elsewhere does not cure a false status claim. “SEC compliant” also implies regulatory review or approval that the SEC does not provide. The wording can mislead investors about oversight, competence, custody, and legitimacy.

**Required closure.** Remove the claims immediately; search all channels and artifacts; preserve publication evidence; identify the exact contracting/advisory/issuer entities; obtain counsel approval for replacement wording. If an adviser later registers, use its exact legal name and CRD number and state that registration does not imply SEC approval, skill, or training.

### C-02 — Irreconcilable Rule 506(b)/506(c) position and public solicitation

**Evidence.** `/discover-fund-a` states Rule 506(c), while the public PPM states Rule 506(b). The website openly advertises strategy, economics, target returns, minimums, liquidity, and a call to invest. SEC guidance identifies unrestricted public websites as a common form of general solicitation. Rule 506(b) generally prohibits general solicitation; Rule 506(c) permits it only with accredited-investor purchasers and reasonable verification steps.

**Risk.** The wrong exemption and solicitation posture can jeopardize the claimed private-offering exemption. The 3(c)(7) qualified-purchaser position in the PPM is a separate Investment Company Act analysis and is not satisfied by a generic accredited-investor checkbox.

**Required closure.** Suspend solicitation. Counsel must choose and document the exemption before relaunch; reconcile the PPM, LPA, subscription agreement, Form D/state notice plan, website, investor communications, and verification workflow. If 506(b) is retained, place offering content behind a counsel-approved relationship and suitability process. If 506(c) is chosen, implement reasonable accredited-investor verification and retain evidence.

### C-03 — Fund performance predates the fund and conflicts with the PPM

**Evidence.** The home page describes “Fund A FY 2025 net return 21.4 percent” (`src/pages/home/ui.tsx:839-865`) and uses a +21.4% image description (`:937`). The reviewed March 2026 PPM says the fund is newly formed, has no operating history, and the strategy has not been implemented in a live fund. Delaware's official entity record lists HUSHH ALPHA ALOHA FUND A LP as formed 26 March 2026. Public community posts nevertheless present 2025 daily NAV/performance as Fund A activity.

**Risk.** The result appears impossible as presented unless it belongs to a predecessor/proprietary/model account and is accurately attributed. Calling gross, backtested, selected, or predecessor results “Fund A” and “net of fees” can be materially misleading. Selective winning periods and daily commentary compound the risk.

**Required closure.** Remove the claim and related charts/posts. Preserve source data. Commission an independent verification covering account ownership, inception, transaction ledger, valuation, all portfolios, cash flows, fees/expenses, methodology, benchmarks, gross/net presentation, hypothetical status, portability to the fund, and required time periods. Do not republish until counsel/compliance approves a substantiation file and fair-and-balanced disclosure.

### C-04 — Confidential private-offering package is publicly accessible

**Evidence.** Anonymous users can retrieve and render the PPM and other fund documents with HTTP 200. The PPM itself says “confidential,” prohibits reproduction, and says Rule 506(b). Public community metadata includes four offering documents and a confidential/internal investor suitability questionnaire. `public/sitemap.xml`, `public/llms.txt`, generated post indexes, static API fallback content, and direct `/fund-documents/*.docx` paths expose or advertise the materials. By contrast, an item correctly classified `accessLevel=NDA` returned 401.

**Risk.** This defeats the NDA, undermines a 506(b) posture, exposes draft/legal material, facilitates search/AI indexing, and creates confidentiality and privilege concerns. Public-cache headers increase persistence after removal.

**Required closure.** Default all investment and confidential content to deny. Move files to private storage; use short-lived signed URLs after server-side authorization; remove static fallbacks; purge caches and search indexes; rotate URLs; inventory every post/deck/object; verify anonymous 401/404 at origin and CDN. Obtain counsel direction on recipients of already-exposed material.

### C-05 — Payment and investor approval can occur without a valid subscription package

**Evidence.** Step 9 calls a minimum $1 Stripe charge a “fund payment,” promises access to Meet the CEO and 300,000 Hushh Coins, and records acceptance of a “Subscription Agreement” while linking only generic Risk Disclosures and Terms (`src/pages/onboarding/step-9/ui.tsx:225-232, 351-456`; `src/services/consent/consentConfig.ts:31`). One timestamp represents risk, eligibility, and subscription acceptance. The PPM instead requires an executed Subscription Agreement, LPA counterpart, KYC/beneficial ownership, source-of-funds evidence, W-9/W-8, wire, and GP acceptance. `supabase/functions/fund-payment-admin-verify/index.ts:74-97` only requires a paid timestamp and allows an administrator to acknowledge missing/high-risk KYC. There is no reliable server gate for accredited/QP verification, signed documents, tax forms, source of funds, or identity completion.

**Risk.** A payment can be mistaken for accepted capital or admission to the fund. The workflow cannot prove what document was accepted, and rewards/CEO access may create improper sales incentives or misleading urgency.

**Required closure.** Disable the path. Build a server-owned state machine in which no money is accepted and no investor is marked verified until eligibility, identity, AML/sanctions, tax, source of funds, executed versioned documents, cooling/rescission rules where applicable, and authorized GP acceptance are complete. Separate a platform-verification charge, if retained, from any capital contribution using clear counsel-approved wording and refunds.

### C-06 — SSNs and EINs are plaintext despite “encrypted/secure” representations

**Evidence.** `src/pages/onboarding/step-3/logic.ts:1058,1083` writes the formatted SSN directly to `ssn_encrypted`. Migration comments explicitly state that the primary SSN and invited-party tax IDs are plaintext (`supabase/migrations/20260620120000_add_party_tax_id.sql:4-18`) and that entity EIN data is plaintext (`supabase/migrations/20260620130000_trust_funding_name_match.sql:10-11`). The schema's `_encrypted` field name and onboarding UI communicate a stronger security posture than is implemented.

**Risk.** High-impact identity theft, deceptive security messaging, breach-notification exposure, and possible safeguarding violations. Database/service-role restrictions do not make plaintext encrypted, and backups/logs/exports expand the exposure surface.

**Required closure.** Stop plaintext collection; rotate/restrict all readers; perform access-log and backup review; tokenize through the identity/KYC provider where possible; otherwise use envelope encryption with per-record data keys and managed KMS, strict purpose-based authorization, no plaintext logging, retention/deletion schedules, tested recovery, and independent verification. Correct all security claims.

## 4. High findings (P1)

### H-01 — Offering terms conflict across the website and governing documents

`/discover-fund-a` lists class minimums, management fees, performance allocations, and hurdles that materially differ from the PPM. The page labels 18–23% as both total expected gross return and target net IRR. It says accredited investors and qualified purchasers; the PPM describes a 3(c)(7) QP-only structure except identified insider/staff classes. Reconcile every number and eligibility rule to one counsel-approved term sheet and make the operative document control conspicuous.

### H-02 — Legal entity and counterparty identity is inconsistent or unverified

The footer uses Hushh Technologies, Inc.; Terms uses “Hushh Technologies Corporation LLC”; other materials use LLC, Corporation, Hushh Advisory LLC, HushOne, Hushh Alpha Aloha Fund A LP, and Hushh Technologies Middle East LLC as GP. Delaware records show a separately named Hushh Alpha Aloha Fund GP LLC. Build a legal-entity matrix with formation jurisdiction, file number, good standing, role, address, ownership, signing authority, bank/custody account, and regulatory status; then correct every surface.

### H-03 — Regulatory, audit, administrator, counsel, broker, and custodian affiliations are not substantiated

Materials claim or name ADGM/CIMA/FSRA/MAS status, an SEC/RIA framework, CFTC exemption, audit, named law firm/counsel, and multiple broker/custodian relationships. The PPM simultaneously says the auditor and administrator are to be appointed and some registrations are future. Obtain written engagement/authorization and exact status for each name/logo before publication. No Hushh match was found in the MAS directory; CIMA and ADGM status could not be independently completed during this audit and remains unverified.

### H-04 — Absolute return, safety, and liquidity language is misleading

Examples include “Assured liquidity,” “market-independent returns,” “4–5% risk-free,” “constitutional guarantee,” “zero material losses,” “Liquid,” “Low Fees,” “Expert Vetted,” “regulated custodian assets,” and “set it and forget it.” The PPM's own risks and redemption discretion contradict absolute language. Replace absolutes with specific, balanced, evidence-backed descriptions positioned beside the claim—not buried on a separate risk page.

### H-05 — Performance advertising lacks required substantiation and presentation controls

Target IRR, hypothetical/backtested results, daily NAV, drawdowns, benchmarks, fees, and selected examples are published without a controlled methodology file. Build a performance policy covering gross/net, all portfolios, prescribed periods, extracted performance, predecessor results, hypothetical assumptions, material risks/limitations, related performance, benchmark comparability, calculation ownership, independent review, and dated approval. The SEC marketing rule is the minimum benchmark if/when an adviser is registered; anti-fraud standards apply more broadly.

### H-06 — Public community posts operate as unreviewed investment communications

The community includes 129 posts and 17 decks, fund updates, trade/NAV commentary, 60–69% targets, confidential investor letters, named individuals/emails, and personal/off-the-cuff statements. Classify every item as corporate, educational, issuer communication, advertisement, testimonial/endorsement, or restricted investor communication. Archive immutable copies, add supervision and pre-approval, substantiate claims, separate personal views, moderate third-party content, and retain complaints/corrections.

### H-07 — Accredited-investor and qualified-purchaser verification is insufficient

The live flow relies primarily on self-attestation and does not execute the public suitability questionnaire. Rule 506(c) requires reasonable verification; a 3(c)(7) fund needs a qualified-purchaser determination. Implement jurisdiction- and entity-specific questionnaires, documentary/third-party verification, beneficial-owner/look-through logic, knowledgeable-employee handling, expiry/reverification, exception approval, and evidence retention. Do not conflate accredited investor, qualified purchaser, qualified client, or sophisticated investor.

### H-08 — AML/KYC/sanctions controls are represented more strongly than implemented

`supabase/functions/_shared/kycScreening.ts:3-15` states there is no external sanctions/PEP/AML provider; form-completeness attestations can default `sanctions_checked` and `pep_checked` to true. Treat the dormant provider integration as unimplemented until production evidence exists. Build identity, CIP-equivalent, beneficial ownership, sanctions/PEP/adverse media, source of funds/wealth, risk scoring, escalation, periodic refresh, and suspicious-activity governance appropriate to the actual entities and counterparties. The FinCEN investment-adviser AML rule's effective date is currently postponed to 1 January 2028; do not describe it as a current federal requirement, but contractual, sanctions, bank, and offering-document obligations still matter.

### H-09 — NDA execution does not establish a reliable document or subscription record

The gate has useful authentication, legal-name, version, timestamp, and per-document acknowledgements, but public access defeats it. The UI can imply “fund agreements” were signed even though it is an NDA acknowledgement. It lacks document content hashes, durable rendered copies, separate assent per agreement, and strong proof the documents were presented. Use counsel-approved e-signature/e-delivery with document hash/version, signer authentication, timestamps, IP/device evidence, consent-to-electronic-records, immutable copies, revocation/re-execution rules, and a clear separation between NDA and subscription execution.

### H-10 — Privacy notices do not match investment onboarding and AI profiling

The general privacy policy reads as website-focused although the application collects identity documents, biometrics through Stripe, SSN/EIN, account/balance/transaction/investment data through Plaid, KYC, tax, source-of-funds, payment, and extensive AI-inferred preferences. It says no automated decision-making, while AI profiling and automated workflow logic exist. Produce an entity/data-flow-specific notice, Reg S-P/GLBA analysis, service-provider matrix, purpose/retention schedule, international transfer basis, rights process, security/incident statement, biometrics notice/consent, and clear automated-processing explanation.

### H-11 — California privacy disclosure is incomplete for the data actually collected

The California notice lists highly sensitive data but lacks a defensible category-to-purpose/recipient/retention matrix and complete sale/share, sensitive-information limitation, opt-out signal, authorized-agent, non-discrimination, metrics, and request-verification handling. Determine thresholds/applicability with privacy counsel, implement Global Privacy Control where required, and verify request deletion across providers, logs, backups, derived profiles, and legal holds.

### H-12 — Public profiles are default-on and privacy logic fails open

`src/pages/hushh-user-profile/logic.ts:471,588` creates profiles as public. The privacy migration defaults nearly every field public. `api/public-investor-profile.js:19-41` treats missing/malformed settings as public and returns `shadow_profile` for confirmed public profiles (`:147`). Even masked email and AI-derived lifestyle/investor attributes can identify or harm users. Change to private, explicit opt-in, field allowlist, fail-closed settings, no shadow profile by default, preview-as-public, consent history, search-engine controls, and deletion/export coverage.

### H-13 — Credential and legacy endpoint exposure requires an incident response

Source contains a hardcoded calendar bearer credential and browser-exposed AI-key paths; Git history contains previously tracked secret-bearing files. A legacy deployable NDA admin function contains a fallback password and wildcard CORS while using service-role access to PII/PDFs. Do not put secret values into issue comments. Rotate/revoke credentials, inspect provider logs, remove browser secrets, inventory all deployed legacy functions, disable the old NDA endpoint, scrub history where counsel/security approves, and enable secret scanning/push protection.

## 5. Medium findings (P2)

### M-01 — AI and superlative branding is unsupported

“The world's first AI-powered Berkshire Hathaway,” “AI-powered Berkshire Hathaway,” and claims that AI minimizes risk or creates market-independent returns require substantiation and balanced limitations. SEC enforcement has specifically targeted false AI claims (“AI washing”). Replace with factual descriptions of deployed capabilities, human oversight, model limitations, validation, conflicts, and data use.

### M-02 — Third-party brand use can imply affiliation or endorsement

Berkshire Hathaway, Renaissance Technologies/Medallion, broker/custodian logos, card-network logos, and “bank-grade/PCI DSS” trust marks appear without a consistent non-affiliation statement or proof of permission. Obtain trademark/counterparty approval or remove them. Vendor compliance does not automatically make Hushh PCI DSS compliant or regulated.

### M-03 — Terms of Service are not fit for the investment workflow

The Terms use an inconsistent legal entity and generic consumer-app language. They do not govern offering access, subscription, e-delivery, electronic signatures, eligibility, payment characterization/refunds, account suspension, communications retention, disputes by entity/jurisdiction, or conflicts with operative fund documents. Replace with counsel-approved platform terms and a clear hierarchy of documents.

### M-04 — Investor Guide contradicts the PPM and links to the wrong legal material

The guide discusses shares, voting, dividends, broad accredited eligibility, and “bank-grade 256-bit” security where the PPM describes limited-partnership interests and different economics/distribution rights. A Terms reference links to Privacy. Treat the guide as advertising: reconcile it line by line, link the operative offering document, and version/approve it.

### M-05 — Consent records are placeholders and over-bundled

`src/services/consent/consentConfig.ts:6-8` says the wording is a placeholder pending legal sign-off and must not ship to production. Financial-data, privacy, biometrics, eligibility, risk, and subscription consents need separate purposes, document versions/hashes, timestamps, withdrawal rules, and evidence. Do not use one timestamp to prove multiple materially different agreements.

### M-06 — Public metrics code exposes an unnecessary row-level fallback

`src/pages/metrics/metricsService.ts:193-240` queries IDs, creation timestamps, and onboarding steps from `public.users` in the browser and computes metrics client-side when the summary API is unavailable. Aggregate server-side, require authorization, suppress small cells, document purpose/retention, and ensure anonymous clients never receive row-level user data.

### M-07 — Legacy anonymous RLS policies may permit broad user-table access

`supabase/migrations/20260116000000_create_hushh_agent_users.sql` grants anonymous/authenticated read and update paths with `USING (true)`. Confirm the migration's production status and table use; revoke obsolete policies; use authenticated ownership checks and server-only writes; test with an anonymous token. Treat actual production exposure as an incident.

### M-08 — Browser/API security headers and trust boundaries need hardening

The live CSP permits `unsafe-inline` and `unsafe-eval`, broad frame/image sources, and permissions not evidently needed. Express exposes `x-powered-by`. Move to nonce/hash-based CSP, narrow `connect-src`/`frame-src`, deny unused permissions, remove server fingerprints, adopt Trusted Types where feasible, and test third-party integrations before enforcing.

### M-09 — Security assurance and dependency monitoring are incomplete

GitHub secret scanning is disabled and code scanning requires GitHub Advanced Security. Two medium Dependabot alerts for `qs` remain open even though the local lockfile's `npm audit` reports zero known vulnerabilities. Reconcile the alerts, enable scanning/push protection or equivalent CI, run gitleaks/trufflehog on full history, add SAST and IaC/container scans, and document exceptions with expiry.

### M-10 — Draft documents and release controls are externally visible

LPAs contain date placeholders and the PPM names future appointments/registrations. Build a controlled document repository with draft/final status, legal owner, approval signature, effective date, immutable version, supersession, audience, retention, and release gate. Production builds should fail if draft markers, false registration terms, confidential-public mappings, or unapproved performance claims are present.

## 6. Low findings (P3)

### L-01 — Accessibility and document semantics are inconsistent

The Fund A page lacks a clear page-level H1 in the audited render, and dense disclosures/documents are difficult to navigate. Run WCAG 2.2 AA automated and keyboard/screen-reader testing, preserve heading order, provide accessible error/consent states, and ensure legal documents are downloadable in accessible formats.

### L-02 — Contact, entity, and legal-link details are inconsistent

Email addresses, entity suffixes, and legal destinations vary; the Investor Guide's Terms link routes to Privacy. Establish a canonical legal/contact configuration and automated broken-link/entity-string tests.

### L-03 — Windows/path portability weakens release reproducibility

`npm run build:web` reached 4,272 modules but failed when the workspace path contained a space and an imported path was resolved as an encoded `/C:/...` URL. Make builds path-independent and validate on Linux and Windows. This is not itself an SEC violation, but failed reproducibility can bypass release and evidence controls.

## 7. Fundrise comparison — useful controls, not a safe harbor

Fundrise is not proof of what Hushh may legally do; its entities, registrations, offerings, and products differ. It is useful only as a current control-design comparator.

| Control | Fundrise observed 15 Sep 2026 | Hushh observed | Required Hushh position |
|---|---|---|---|
| Registration wording | Names Fundrise Advisors, LLC as the registered adviser; links Form ADV/CRS/client agreement; says registration does not imply skill/training | Generic “SEC Registered” badges and false entity-level statement | Exact legal entity, CRD/file evidence, limitation language—or no claim |
| Offering status | Separates registered funds, unregistered Reg A, and Reg D offerings | 506(b), 506(c), RIA, 3(c)(7), and “registered fund” messages conflict | One counsel-approved status per entity/product |
| Offer mechanics | Says offers/sales occur only through the applicable definitive offering document and money is not accepted beforehand | $1 “fund payment” before executed subscription package | Server-enforced document, eligibility, KYC, tax, and acceptance state machine |
| Performance | Defines methodology/scope, net-of-fee treatment, hypothetical labeling, risks, and comparability limits | +21.4% predates vehicle; 18–23% gross and net labels conflict | Independent substantiation and controlled fair/balanced presentation |
| Liquidity/risk | Repeats potential partial/total loss and no-guarantee language; qualifies redemption/liquidity | “Assured liquidity,” “risk-free,” “market-independent” | Specific limitations beside every material benefit claim |
| Documents | Maintains organized offering circulars/prospectuses and adviser disclosures | Confidential/draft package is publicly indexed and contradictory | Controlled final document library with audience/version gates |
| Social/community | Has a dedicated social-media disclosure and testimonial/endorsement framework | Fund-like daily communications are publicly posted without visible supervision | Advertising classification, approval, archive, moderation, complaints process |
| Cookies/privacy | Provides granular accept/reject/storage preferences | No comparable consent control was observed in the audited public flow | Jurisdictional consent and preference center aligned to actual trackers |

## 8. Positive controls observed

These controls reduce risk but do not offset the P0 findings:

- Correctly classified NDA content can return 401 to anonymous requests.
- The current NDA workflow authenticates the user, binds the server-side user identity, captures legal name/version/time, and requires document acknowledgements.
- The current GCP NDA administrator path uses a custom claim and pseudonymized list output.
- Sensitive pages use no-store behavior; live headers include HSTS, `nosniff`, SAMEORIGIN, and a strict referrer policy.
- Current Cloud Run handlers generally use bounded request bodies, strict authentication, and explicit ID maps.
- Plaid access tokens have a KMS-encrypted storage path.
- Stripe status is updated by webhook rather than trusting a browser success flag.
- Targeted compliance/security tests passed 60/60, community tests passed 19/19, environment validation passed, community deck audit passed, and local `npm audit` found zero vulnerabilities in 1,207 packages.

## 9. Remediation program and acceptance criteria

### Phase 0 — Preserve and contain (0–24 hours)

- [ ] Create a legal hold/evidence bundle and name its custodian.
- [ ] Suspend investment marketing, onboarding, payment, and public community investment content.
- [ ] Remove registration/compliance badges and absolute safety/return/liquidity claims across all channels.
- [ ] Make every offering/confidential object private at origin; purge CDN/search/LLM indexes.
- [ ] Stop plaintext SSN/EIN collection; restrict existing records; rotate exposed credentials.
- [ ] Open incident records for confidential-document and credential exposure.

**Exit:** Anonymous tests show no offering/confidential content; no payment can be created; no new tax ID can enter plaintext storage; counsel/compliance has the preserved evidence.

### Phase 1 — Establish the legal product (1–7 days)

- [ ] Approve the exact issuer, fund, GP, adviser/manager, technology company, feeder, and contracting entities.
- [ ] Obtain formation/good-standing/signing-authority evidence and verify all regulator/counterparty claims.
- [ ] Select and document 506(b) or 506(c), 3(c)(7)/other Investment Company Act position, Form D/state filing plan, and non-U.S. offering restrictions.
- [ ] Approve one final PPM/LPA/Subscription Agreement/term sheet with consistent classes, fees, hurdle, eligibility, liquidity, and risks.
- [ ] Determine whether historical results may be used and commission independent performance verification.
- [ ] Approve the marketing, social/community, performance, privacy, conflicts, complaint, and record-retention policies.

**Exit:** Written securities-counsel memorandum and compliance approval identify what may be said, to whom, by which entity, under which exemption, using which final documents.

### Phase 2 — Rebuild the investor-control plane (1–30 days)

- [ ] Implement a server-side eligibility, identity, sanctions/PEP, source-of-funds, tax, signature, payment, and GP-acceptance state machine.
- [ ] Remove the KYC-risk override or require documented dual approval with non-bypassable hard stops.
- [ ] Integrate and evidence production identity/sanctions screening; distinguish provider response from manual attestation.
- [ ] Implement versioned e-sign/e-delivery with hashes, immutable copies, separate consents, and re-execution on material change.
- [ ] Replace plaintext tax-ID storage with tokenization/envelope encryption and tested deletion/retention.
- [ ] Default profiles private and make all public-data selection fail closed.
- [ ] Put community/offering assets in private storage with authorization, expiring URLs, audit logs, and cache controls.

**Exit:** Negative integration tests prove no user, admin, stale client, coupon, webhook replay, or direct API request can bypass a required gate.

### Phase 3 — Controlled relaunch (30–60 days)

- [ ] Rebuild every public page from approved claim/disclosure components and one canonical entity/term source.
- [ ] Add marketing pre-approval, expiry, substantiation IDs, immutable capture, channel inventory, and books-and-records retention.
- [ ] Publish accurate privacy/California/biometrics/financial-data notices and a tracker preference center.
- [ ] Harden CSP/permissions, remove browser secrets/legacy endpoints, enable secret/SAST/dependency scanning, and close alerts.
- [ ] Complete accessibility, broken-link, SEO/index, cache, and authenticated/anonymous E2E testing.
- [ ] Conduct independent securities-counsel, privacy, application-security, and performance reviews.

**Exit:** Each P0/P1 item has evidence, owner, independent reviewer, regression test, and written compliance sign-off; production matches the approved release hash.

### Ongoing — Supervision and evidence

- [ ] Quarterly claim/entity/filing review; annual policy and privacy review; event-driven review on any document or strategy change.
- [ ] Daily communications archive for public, email, community, social, deck, and investor-update channels.
- [ ] Incident/complaint register, vendor due diligence, access review, KMS rotation, restore test, vulnerability SLA, and tabletop exercise.
- [ ] Annual independent performance-methodology and marketing sample review.

## 10. Evidence required before a relaunch decision

1. Exact legal names, formation certificates, good-standing certificates, ownership, managers/directors, and signing authority for every involved entity.
2. Adviser status memorandum; CRD/IARD/Form ADV/Form CRS if applicable; exempt-reporting basis if applicable.
3. Final exemption memorandum, Form D/state notice calendar, first-sale date, offeree/purchaser log, and non-U.S. jurisdiction matrix.
4. Final executed PPM, LPA, Subscription Agreement, side-letter policy, valuation policy, conflicts policy, and custody/audit analysis.
5. Engagement/authorization letters for counsel, administrator, auditor, banks, brokers, custodians, KYC vendor, and every displayed logo/name.
6. Complete performance ledger and methodology, including predecessor/model/backtest classification, fees, all accounts, valuations, cash flows, benchmarks, and independent sign-off.
7. Accredited/QP/qualified-client determination procedure and sample redacted evidence.
8. KYC/AML/sanctions/provider configuration, beneficial ownership, source-of-funds/wealth, escalation, periodic review, and record-retention evidence.
9. Data inventory and flow map for SSN/EIN, identity/biometrics, Plaid, Stripe, analytics, AI profiles, emails, documents, logs, backups, and subprocessors.
10. Production deployment/function inventory, secrets inventory/rotation proof, database/RLS policy export, access logs, incident assessment, and tested restore/deletion evidence.

## 11. Verification performed and limitations

### Performed

- Reviewed the React/Vite frontend, Express/Cloud Run APIs, Supabase migrations/functions, routing, generated community indexes, public assets, legal pages, onboarding steps, payment flow, KYC logic, NDA flow, profile/privacy logic, metrics, headers, CI/workflows, and repository history indicators.
- Exercised production and UAT anonymously across public/legal/community/offering paths and direct document/API URLs.
- Compared the current Fundrise disclosure and offering-document design as of the audit date.
- Checked the SEC current RIA and ERA data (1 September 2026), EDGAR searches, Delaware entity search, and MAS directory. CIMA was blocked by reCAPTCHA and ADGM by an anti-bot challenge; those claims remain unverified, not disproved.
- Ran targeted tests: 5 files/60 tests passed; community: 2 files/19 tests passed; environment check passed; deck audit passed; local dependency audit found 0 vulnerabilities.
- Ran the full Vitest suite: 249 files—208 passed, 39 failed, 2 skipped; 1,957 tests—1,814 passed, 77 failed, 66 skipped. Failures were concentrated in Windows/POSIX assumptions, stale hash-bound migration/deployment evidence, repository-freshness contracts, and release tooling. They still mean the full release gate is not green.
- Build reached 4,272 transformed modules, then failed on a Windows path-with-spaces resolution defect.

### Limitations

- No privileged investor/admin account, production database, cloud console, payment/KYC vendor dashboard, regulator account, email/SMS inbox, or executed legal/counterparty files were provided.
- No real investment, identity-document upload, bank link, wire, refund, administrator approval, or destructive security test was performed.
- `gcloud`, WSL/bash, LibreOffice, and gitleaks were unavailable in this Windows workspace; the UAT NDA release gate, DOCX visual rendering, and a full-history secret-scanner run could not be completed.
- GitHub secret scanning is disabled and code scanning is not enabled for this private repository. Two medium Dependabot alerts for `qs` were open on the audit date.
- Absence from searches is based on the names reviewed. An undisclosed legal/DBA/CRD identity could change part of the registry conclusion, but it would not cure the current website's unsupported wording without exact attribution.
- This was a high-coverage audit, not a claim that every jurisdictional requirement or latent vulnerability has been identified.

## 12. Authoritative references

- SEC, [Investment Adviser Marketing](https://www.sec.gov/resources-small-businesses/small-business-compliance-guides/investment-adviser-marketing)
- SEC, [Marketing Compliance FAQs](https://www.sec.gov/rules-regulations/staff-guidance/division-investment-management-frequently-asked-questions/marketing-compliance-frequently-asked-questions)
- SEC, [General Solicitation](https://www.sec.gov/resources-small-businesses/capital-raising-building-blocks/general-solicitation)
- SEC, [Rule 506(c)](https://www.sec.gov/resources-small-businesses/exempt-offerings/general-solicitation-rule-506c)
- SEC, [Assessing Accredited Investors under Regulation D](https://www.sec.gov/resources-small-businesses/capital-raising-building-blocks/assessing-accredited-investors-under-regulation-d)
- SEC, [Current RIA and ERA data](https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers)
- SEC, [Regulation S-P amendments](https://www.sec.gov/rules-regulations/2024/06/s7-05-23)
- SEC, [AI-washing enforcement announcement](https://www.sec.gov/newsroom/press-releases/2024-36)
- FinCEN, [Investment-adviser AML effective date postponed to 2028](https://www.fincen.gov/news/news-releases/fincen-issues-final-rule-postpone-effective-date-investment-adviser-rule-2028)
- FINRA, [Rule 2210 Communications with the Public](https://www.finra.org/rules-guidance/rulebooks/finra-rules/2210) (applies if a FINRA member is involved; used here as a communications-control benchmark)
- Fundrise, [Full Disclosure](https://fundrise.com/legal/disclosure) and [Offering Circulars](https://fundrise.com/oc) (comparator only)

## 13. Final gate

HushhTech should not describe itself, its fund, or its adviser as SEC registered; should not publish the reviewed performance or confidential offering package; and should not accept fund-related payments under the present workflow. Relaunch requires closure of all P0 and P1 findings, regression evidence, and written approval from securities counsel and the accountable compliance officer. A footer disclaimer alone is not an acceptable remediation.
