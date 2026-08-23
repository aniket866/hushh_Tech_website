#!/bin/bash

# Script to update Supabase Auth URL Configuration.
# Keeps production as the default Site URL while preserving UAT/local redirect
# targets so OAuth flows started on uat.hushhtech.com return to UAT.

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PROJECT_REF="ibsisfnjxeowvdtvgzff"
NEW_SITE_URL="https://hushhtech.com"
REQUIRED_REDIRECT_URLS=(
    "https://hushhtech.com/**"
    "https://hushhtech.com/auth/callback"
    "https://hushhtech.com/auth/callback?redirect=/hushh-ai"
    "https://hushhtech.com/hushh-agents"
    "https://uat.hushhtech.com/**"
    "https://uat.hushhtech.com/auth/callback"
    "https://www.hushhtech.com/**"
    "https://www.hushhtech.com/"
    "https://www.hushhtech.com/auth/callback"
    "https://www.hushhtech.com/auth/callback?redirect=/hushh-ai"
    "https://www.hushhtech.com/hushh-agents"
    "https://www.hushh.ai"
    "https://www.hushh.ai/**"
    "www.hushh.ai"
    "www.hushh.ai/**"
    "www.hushhtech.com"
    "hushh://auth/callback"
    "hushh://**"
    "ai.hushh.app://"
    "ai.hushh.app://**"
    "capacitor://localhost"
    "http://localhost:3000/**"
    "http://localhost:5173/**"
    "http://localhost:5173/hushh-agents"
    "http://localhost:5174/**"
    "http://localhost:5174/hushh-agents"
)

decode_keychain_token() {
    python3 - "$1" <<'PY'
import base64
import sys

raw = sys.argv[1]
if raw.startswith("go-keyring:"):
    raw = base64.b64decode(raw.split(":", 1)[1]).decode()
print(raw)
PY
}

get_supabase_access_token() {
    if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
        printf '%s' "$SUPABASE_ACCESS_TOKEN"
        return 0
    fi

    local access_token_file="$HOME/.supabase/access-token"
    if [ -f "$access_token_file" ]; then
        cat "$access_token_file"
        return 0
    fi

    if command -v security >/dev/null 2>&1; then
        local keychain_token
        keychain_token=$(security find-generic-password -a access-token -s "Supabase CLI" -w 2>/dev/null || true)
        if [ -n "$keychain_token" ]; then
            decode_keychain_token "$keychain_token"
            return 0
        fi
    fi

    return 1
}

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}Supabase Auth URL Configuration Update${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo -e "Project: ${GREEN}${PROJECT_REF}${NC}"
echo -e "New Site URL: ${GREEN}${NEW_SITE_URL}${NC}"
echo ""

# Check if supabase CLI is logged in
if ! npx supabase projects list &>/dev/null; then
    echo -e "${RED}Error: Not logged in to Supabase CLI${NC}"
    echo "Please run: npx supabase login"
    exit 1
fi

echo -e "${GREEN}✓ Supabase CLI is logged in${NC}"

# Get access token from Supabase CLI login
echo ""
echo -e "${YELLOW}Getting access token...${NC}"

if ACCESS_TOKEN=$(get_supabase_access_token); then
    echo -e "${GREEN}✓ Access token found${NC}"
else
    echo -e "${RED}Error: Supabase access token not found${NC}"
    echo "Please run: npx supabase login"
    exit 1
fi

# Read current auth config so we preserve existing URLs/provider settings
echo ""
echo -e "${YELLOW}Reading current Auth configuration...${NC}"

CURRENT_AUTH_CONFIG=$(curl -s -X GET \
  "https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")

if ! echo "$CURRENT_AUTH_CONFIG" | jq -e '.uri_allow_list' >/dev/null 2>&1; then
    echo -e "${RED}Error reading auth configuration:${NC}"
    echo "$CURRENT_AUTH_CONFIG"
    exit 1
fi

REQUIRED_JSON=$(printf '%s\n' "${REQUIRED_REDIRECT_URLS[@]}" | jq -R . | jq -s .)
UPDATED_ALLOW_LIST=$(jq -r --argjson required "$REQUIRED_JSON" '
  (.uri_allow_list // "")
  | split(",")
  | map(gsub("^\\s+|\\s+$"; ""))
  | map(select(length > 0))
  + $required
  | unique
  | join(",")
' <<<"$CURRENT_AUTH_CONFIG")

PATCH_BODY=$(jq -n \
  --arg site_url "$NEW_SITE_URL" \
  --arg uri_allow_list "$UPDATED_ALLOW_LIST" \
  '{site_url: $site_url, uri_allow_list: $uri_allow_list}')

# Update auth config via Management API
echo ""
echo -e "${YELLOW}Updating Site URL and redirect allow-list via Supabase Management API...${NC}"

RESPONSE=$(curl -s -X PATCH \
  "https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PATCH_BODY")

# Check if the update was successful
if echo "$RESPONSE" | grep -q "site_url"; then
    echo -e "${GREEN}✓ Auth configuration updated successfully!${NC}"
    echo ""
    echo -e "${GREEN}New Configuration:${NC}"
    echo "$RESPONSE" | jq '.site_url, .uri_allow_list' 2>/dev/null || echo "$RESPONSE"
else
    echo -e "${RED}Error updating auth configuration:${NC}"
    echo "$RESPONSE"
    echo ""
    echo -e "${YELLOW}If this failed, please update manually:${NC}"
    echo "1. Go to: https://supabase.com/dashboard/project/${PROJECT_REF}/auth/url-configuration"
    echo "2. Set Site URL to: https://hushhtech.com"
    echo "3. Add these Redirect URLs:"
    echo "   - https://hushhtech.com/auth/callback"
    echo "   - https://hushhtech.com/auth/callback?redirect=/hushh-ai"
    echo "   - https://uat.hushhtech.com/auth/callback"
    echo "   - https://uat.hushhtech.com/**"
    echo "   - https://www.hushhtech.com/auth/callback"
    echo "   - https://www.hushhtech.com/auth/callback?redirect=/hushh-ai"
    echo "   - hushh://auth/callback"
    echo "   - https://hushhtech.com/**"
    exit 1
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}OAuth redirect allow-list now includes production and UAT${NC}"
echo -e "${GREEN}========================================${NC}"
