#!/bin/bash
# Security Audit Issues Creator — Hushh Fund Platform
# Creates issues, assigns them, adds to project #73 with roadmap dates

REPO="hushh-labs/hushh_Tech_website"
PROJECT_NUM=73
ORG="hushh-labs"
ASSIGNEE="ankitkumarsingh1702"
START_DATE_FIELD="PVTF_lADOCFn_ns4BNuR1zg8opjM"
TARGET_DATE_FIELD="PVTF_lADOCFn_ns4BNuR1zg8opjQ"
PROJECT_ID="PVT_kwDOCFn_ns4BNuR1"

create_issue_and_add_to_project() {
  local title="$1"
  local body="$2"
  local labels="$3"
  local start="$4"
  local target="$5"

  echo "📝 Creating: $title"
  
  # Create issue
  ISSUE_URL=$(gh issue create \
    --repo "$REPO" \
    --title "$title" \
    --body "$body" \
    --assignee "$ASSIGNEE" \
    --label "$labels" 2>&1 | tail -1)
  
  echo "   ✅ Issue created: $ISSUE_URL"
  
  # Add to project
  ITEM_ID=$(gh project item-add "$PROJECT_NUM" \
    --owner "$ORG" \
    --url "$ISSUE_URL" \
    --format json 2>&1 | jq -r '.id')
  
  echo "   📋 Added to project, item: $ITEM_ID"
  
  # Set start date
  if [ -n "$start" ] && [ "$ITEM_ID" != "null" ] && [ -n "$ITEM_ID" ]; then
    gh project item-edit \
      --project-id "$PROJECT_ID" \
      --id "$ITEM_ID" \
      --field-id "$START_DATE_FIELD" \
      --date "$start" 2>&1 > /dev/null
    echo "   📅 Start: $start"
  fi
  
  # Set target date
  if [ -n "$target" ] && [ "$ITEM_ID" != "null" ] && [ -n "$ITEM_ID" ]; then
    gh project item-edit \
      --project-id "$PROJECT_ID" \
      --id "$ITEM_ID" \
      --field-id "$TARGET_DATE_FIELD" \
      --date "$target" 2>&1 > /dev/null
    echo "   🎯 Target: $target"
  fi
  
  echo ""
  sleep 1
}

echo "🔒 HUSHH SECURITY AUDIT — Creating 20 Issues"
echo "================================================"
echo ""

# ====== DAY 1: Mar 13 ======

create_issue_and_add_to_project \
  "[CRITICAL] Fix Wildcard CORS — Restrict to hushh.ai domain only" \
  "## 🔴 CRITICAL — CVSS 8.1/10
### VULN-004: Wildcard CORS on ALL Endpoints

**Problem:**
Every endpoint has \`Access-Control-Allow-Origin: *\` — any website can make API requests to our endpoints from a user's browser.

**Files to fix:**
- \`vercel.json\` (headers configuration)
- \`supabase/functions/_shared/cors.ts\`
- \`api/generate-investor-profile.js\`
- \`api/send-email-notification.js\`

**Impact:**
Any malicious website can call Plaid, OpenAI, and account-deletion APIs from a user's browser session when user is logged into hushh.ai.

**Fix:**
\`\`\`javascript
// vercel.json
{ \"key\": \"Access-Control-Allow-Origin\", \"value\": \"https://hushh.ai\" }

// cors.ts
export const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://hushh.ai',
  'Access-Control-Allow-Credentials': 'true',
};
\`\`\`

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 4, VULN-004" \
  "security,bug" \
  "2026-03-13" "2026-03-14"

create_issue_and_add_to_project \
  "[CRITICAL] Add JWT Auth to ALL Supabase Edge Functions" \
  "## 🔴 CRITICAL — CVSS 9.8/10
### VULN-003: No Authentication on Plaid Edge Functions

**Problem:**
5 out of 6 Plaid-related Edge Functions have ZERO JWT/auth verification. Anyone with the function URL can call Plaid APIs.

**Unprotected functions:**
- \`supabase/functions/create-link-token/index.ts\`
- \`supabase/functions/identity-match/index.ts\`
- \`supabase/functions/asset-report-create/index.ts\`
- \`supabase/functions/signal-evaluate/index.ts\`
- \`supabase/functions/signal-prepare/index.ts\`

**Fix — Add to ALL Edge Functions:**
\`\`\`typescript
const authHeader = req.headers.get('Authorization');
if (!authHeader?.startsWith('Bearer ')) {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
}
const token = authHeader.replace('Bearer ', '');
const { data: { user }, error } = await supabase.auth.getUser(token);
if (error || !user) {
  return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 });
}
\`\`\`

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 4, VULN-003" \
  "security,bug" \
  "2026-03-13" "2026-03-15"

# ====== DAY 2: Mar 14 ======

create_issue_and_add_to_project \
  "[CRITICAL] Add Auth to ALL Vercel API Routes" \
  "## 🔴 CRITICAL — CVSS 8.6/10
### VULN-005: No Authentication on Vercel API Routes

**Problem:**
ALL 6 Vercel API routes have ZERO authentication. Anyone can burn OpenAI/Gemini credits or send emails.

**Files:**
- \`api/generate-investor-profile.js\`
- \`api/send-email-notification.js\`
- \`api/gemini-ephemeral-token.js\`
- \`api/career-application.js\`
- \`api/enrich-preferences.js\`
- \`api/wallet-pass.js\`

**Fix — Add to every route:**
\`\`\`javascript
const token = req.headers.authorization?.replace('Bearer ', '');
if (!token) return res.status(401).json({ error: 'Unauthorized' });
const { data: { user }, error } = await supabase.auth.getUser(token);
if (error || !user) return res.status(401).json({ error: 'Invalid token' });
\`\`\`

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 4, VULN-005" \
  "security,bug" \
  "2026-03-14" "2026-03-15"

create_issue_and_add_to_project \
  "[CRITICAL] Fix Open Redirect Vulnerability in Login/Signup" \
  "## 🔴 CRITICAL — CVSS 7.4/10
### VULN-006: Open Redirect via redirect Query Parameter

**Problem:**
\`redirect\` query param used directly for navigation with ZERO validation. Enables phishing attacks against investors.

**Files:**
- \`src/pages/Login.tsx\`
- \`src/pages/Signup.tsx\`
- \`src/pages/login/logic.ts\`
- \`src/pages/signup/logic.ts\`

**Attack:** \`hushh.ai/login?redirect=https://evil-site.com\`

**Fix:**
\`\`\`typescript
function validateRedirect(redirect: string): string {
  if (!redirect.startsWith('/')) return '/hushh-user-profile';
  if (redirect.includes('://')) return '/hushh-user-profile';
  if (redirect.startsWith('//')) return '/hushh-user-profile';
  return redirect;
}
\`\`\`

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 4, VULN-006" \
  "security,bug" \
  "2026-03-14" "2026-03-15"

# ====== DAY 3: Mar 15 ======

create_issue_and_add_to_project \
  "[CRITICAL] Move Plaid Access Token to Server-Side Only Storage" \
  "## 🔴 CRITICAL — CVSS 9.8/10
### VULN-001: Plaid Access Token Exposed to Client-Side Code

**Problem:**
Plaid access_token (PERMANENT bank credential) stored as plaintext in client-accessible \`user_financial_data\` table. Client code reads it back via \`select('plaid_access_token, ...')\`.

**Files:**
- \`src/services/plaid/plaidService.ts\` (line ~220)
- \`src/pages/onboarding/step-13/logic.ts\` (line ~228)

**Impact:**
Any XSS = ALL users' bank tokens stolen. Permanent access to bank accounts.

**Fix:**
1. Create \`plaid_tokens\` table with NO RLS select policy
2. Remove plaid_access_token from all client queries
3. All Plaid API calls through Edge Functions only
4. Rotate all existing tokens after fix

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 4, VULN-001" \
  "security,bug" \
  "2026-03-15" "2026-03-16"

create_issue_and_add_to_project \
  "[CRITICAL] Replace Base64 Encoding with AES-256 Encryption for Bank Data" \
  "## 🔴 CRITICAL — CVSS 9.1/10
### VULN-002: Bank Account Numbers Fake-Encrypted with btoa()

**Problem:**
\`const encryptedAccountNumber = btoa(accountNumber);\` — btoa() is Base64 ENCODING, NOT encryption. Anyone decodes with atob().

**Files:**
- \`src/pages/onboarding/step-13/logic.ts\` (line ~350)
- \`src/pages/onboarding/Step13.tsx\` (legacy)

**Fix:**
1. Server-side AES-256-GCM encryption in Edge Function
2. Encryption key in Supabase Vault
3. Client never handles raw bank numbers
4. Implement tokenization

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 4, VULN-002" \
  "security,bug" \
  "2026-03-15" "2026-03-16"

# ====== DAY 4: Mar 16 ======

create_issue_and_add_to_project \
  "[CRITICAL] Add Security Headers — HSTS, CSP, X-Frame-Options" \
  "## 🔴 HIGH — Security Headers Missing

**Problem:**
No Content Security Policy, no HSTS, no X-Frame-Options, no Referrer-Policy configured.

**Files:** \`vercel.json\`

**Required headers:**
\`\`\`
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; script-src 'self' https://www.googletagmanager.com; ...
\`\`\`

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 6, MED-005 & MED-006" \
  "security,enhancement" \
  "2026-03-16" "2026-03-17"

create_issue_and_add_to_project \
  "[HIGH] Implement Audit Logs Table for SEC/FINRA Compliance" \
  "## 🟠 HIGH — No Audit Trail / Activity Logging
### HIGH-006

**Problem:**
No audit log for financial data access, NDA signing, KYC events, login/logout, investment actions. Required by SEC and FINRA.

**Fix:**
\`\`\`sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  ip_address INET,
  user_agent TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
-- Immutable: No UPDATE/DELETE policies
\`\`\`

Log events: auth.login, nda.signed, kyc.step_completed, plaid.account_linked, fund.viewed, profile.updated

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 5, HIGH-006" \
  "security,enhancement" \
  "2026-03-16" "2026-03-17"

# ====== DAY 5: Mar 17 ======

create_issue_and_add_to_project \
  "[HIGH] Enforce NDA at API Level — Not Just Client-Side" \
  "## 🟠 HIGH — NDA Enforcement is Client-Side Only
### HIGH-003

**Problem:**
NDA enforced via GlobalNDAGate React component only. Bypassed by modifying React state, direct API calls, or disabling JS.

**Files:**
- \`src/components/GlobalNDAGate.tsx\`
- \`src/services/nda/ndaService.ts\`

**Fix:**
Every Edge Function returning fund data must check NDA:
\`\`\`typescript
async function checkNDA(userId, supabase) {
  const { data } = await supabase
    .from('nda_signatures').select('signed_at')
    .eq('user_id', userId).single();
  if (!data?.signed_at) throw new Error('NDA not signed');
}
\`\`\`

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 5, HIGH-003" \
  "security,bug" \
  "2026-03-17" "2026-03-18"

create_issue_and_add_to_project \
  "[HIGH] Implement Server-Side Onboarding Step Validation" \
  "## 🟠 HIGH — Onboarding Steps Can Be Skipped
### HIGH-002

**Problem:**
13-step KYC onboarding enforced by client-side routing only. Users can navigate directly to /onboarding/step-13 skipping identity verification.

**Impact:** SEC Regulation D non-compliance — unverified investors can access fund.

**Fix:**
1. Create \`onboarding_progress\` table tracking each step completion
2. Edge Function validates step order before allowing progress
3. Fund access APIs check onboarding_completed_at IS NOT NULL

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 5, HIGH-002" \
  "security,bug" \
  "2026-03-17" "2026-03-18"

# ====== DAY 6: Mar 18 ======

create_issue_and_add_to_project \
  "[HIGH] Implement SSN Tokenization with Server-Side Encryption" \
  "## 🟠 HIGH — SSN Storage Without Proper Encryption
### HIGH-001

**Problem:**
SSN collected in Step 9 — encryption level at database layer unclear. SSN is the most sensitive PII.

**Requirements:**
- AES-256 encryption at rest
- Tokenize SSN (store reference, not actual)
- Only last 4 digits displayed to users
- All access logged in audit trail
- Never appears in logs or network responses

**Files:** \`src/pages/onboarding/step-9/logic.ts\`

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 5, HIGH-001" \
  "security,bug" \
  "2026-03-18" "2026-03-19"

create_issue_and_add_to_project \
  "[HIGH] Implement Rate Limiting on All Endpoints" \
  "## 🟠 HIGH — No Rate Limiting Anywhere
### HIGH-004

**Problem:**
Zero rate limiting on login/signup (brute force), Plaid calls (API abuse), AI endpoints (cost attack $$$$), email notifications (spam).

**Fix with Upstash:**
\`\`\`typescript
import { Ratelimit } from '@upstash/ratelimit';
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, '60 s'),
});
\`\`\`

**Per-endpoint limits:**
- Login: 5/15min per IP
- Signup: 3/hour per IP
- AI chat: 20/hour per user
- Financial APIs: 10/hour per user

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 5, HIGH-004" \
  "security,enhancement" \
  "2026-03-18" "2026-03-19"

# ====== DAY 7: Mar 19 ======

create_issue_and_add_to_project \
  "[HIGH] Remove Sensitive Data from Console Logs" \
  "## 🟠 HIGH — Sensitive Data in Console Logs
### HIGH-005

**Problem:**
console.log statements throughout financial services may expose user IDs, Plaid tokens, financial data, PII.

**Fix:**
1. Audit ALL console.log/warn/error in src/services/ and src/pages/onboarding/
2. Remove any that contain tokens, PII, financial data
3. Replace with structured logging (Sentry)
4. Never log: tokens, passwords, SSN, account numbers

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 5, HIGH-005" \
  "security,bug" \
  "2026-03-19" "2026-03-20"

create_issue_and_add_to_project \
  "[MEDIUM] Add Session Timeout for Financial Platform" \
  "## 🟡 MEDIUM — No Session Timeout

**Problem:**
No idle timeout configured. Unattended sessions on shared/public computers remain active indefinitely.

**Industry Standard:** 30 min idle timeout, 8 hour absolute timeout.

**Fix:**
- Track last activity timestamp
- Auto-logout after 30 min inactivity
- Force re-auth after 8 hours regardless
- Clear all tokens on logout

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 7, LOW-010" \
  "security,enhancement" \
  "2026-03-19" "2026-03-20"

# ====== DAY 8: Mar 20 ======

create_issue_and_add_to_project \
  "[MEDIUM] Fix Data Masking Defaults — maskSensitiveData.ts" \
  "## 🟡 MEDIUM — Data Masking Has Dangerous Defaults
### MED-002

**Problem:**
\`maskOnboardingField\` returns UNMASKED data for unknown field types. Any new field = auto-exposed.

**File:** \`src/utils/maskSensitiveData.ts\`

**Fix:**
\`\`\`typescript
default:
  return typeof value === 'string' ? '●●●●●●' : value;
\`\`\`

Also fix: maskEmail exposes full domain (company identity leak).

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 6, MED-002" \
  "security,bug" \
  "2026-03-20" "2026-03-21"

create_issue_and_add_to_project \
  "[MEDIUM] Remove DevTools Guard — Security Theater" \
  "## 🟡 MEDIUM — DevTools Guard Provides Zero Security
### MED-001

**Problem:**
\`src/utils/devtools-guard.ts\` attempts to block DevTools. This is trivially bypassed and harms legitimate users (destroys page on slow machines).

**Fix:** Remove file entirely. Delete import from main.tsx or wherever it's imported. Invest in server-side security instead.

**File:** \`src/utils/devtools-guard.ts\`

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 6, MED-001" \
  "security,enhancement" \
  "2026-03-20" "2026-03-21"

# ====== DAY 9: Mar 21 ======

create_issue_and_add_to_project \
  "[MEDIUM] Remove Hardcoded Supabase Credentials from Source" \
  "## 🟡 MEDIUM — Hardcoded Supabase Fallback Credentials
### MED-004

**Problem:**
Supabase URL and anon key hardcoded as fallbacks in config. Committed to public GitHub repo. Can't rotate without deploy.

**File:** \`src/resources/config/config.ts\`

**Fix:**
- Remove fallback values
- Fail explicitly if env vars missing:
\`\`\`typescript
if (!import.meta.env.VITE_SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
\`\`\`

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 6, MED-004" \
  "security,bug" \
  "2026-03-21" "2026-03-22"

create_issue_and_add_to_project \
  "[MEDIUM] Remove Firebase — Consolidate to Supabase Only" \
  "## 🟡 MEDIUM — Dual Auth Systems
### MED-003

**Problem:**
Both Firebase and Supabase in package.json. Dual auth systems = confusion, potential bypass, increased attack surface.

**Fix:**
- Verify Firebase is not actively used
- Remove firebase dependency from package.json
- Remove any firebase imports/configs
- Consolidate all auth to Supabase

**File:** \`package.json\`

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 6, MED-003" \
  "security,enhancement" \
  "2026-03-21" "2026-03-22"

# ====== DAY 10: Mar 22-23 ======

create_issue_and_add_to_project \
  "[LOW] Protect KYC Demo Page and Clean Up Root SQL Files" \
  "## 🟢 LOW — Production Cleanup Required

**Issues:**
1. \`/kyc-demo\` page accessible in production with hardcoded test users
2. One-off SQL scripts need to stay grouped under \`supabase/manual-sql/\`

**Fix:**
1. Add environment check to /kyc-demo — disable in production
2. Convert reusable SQL into \`supabase/migrations/\` and keep manual scripts in \`supabase/manual-sql/\`
3. Archive or remove legacy Step*.tsx files that co-exist with the new step-*/logic.ts pattern

**Ref:** docs/SECURITY_AUDIT_REPORT.txt — Section 7, LOW-007 & LOW-012" \
  "security,enhancement" \
  "2026-03-22" "2026-03-23"

echo ""
echo "================================================"
echo "✅ All 20 issues created successfully!"
echo "📋 Project: Hussh Engineering Core (#73)"
echo "👤 Assigned: ankitkumarsingh1702"
echo "📅 Roadmap: Mar 13 - Mar 23, 2026"
echo "================================================"
