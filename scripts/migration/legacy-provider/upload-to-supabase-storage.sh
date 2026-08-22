#!/bin/bash
# =====================================================
# Supabase Storage Upload Script
# Creates bucket (if needed) and uploads file to Supabase Storage
# =====================================================

set -e

SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
BUCKET_NAME="assets"

if [ -z "$SUPABASE_ACCESS_TOKEN" ] || [ -z "$PROJECT_REF" ]; then
    echo "❌ Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF before running this script."
    exit 1
fi

SUPABASE_URL="https://${PROJECT_REF}.supabase.co"

# File to upload
FILE_PATH="${1:-/Users/ankitkumarsingh/Downloads/Hushhogo-tDRfOnun.png}"
FILE_NAME="${2:-hushh-logo.png}"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🚀 Supabase Storage Upload Script${NC}"
echo "================================================"
echo "📁 File: $FILE_PATH"
echo "📦 Bucket: $BUCKET_NAME"
echo "📝 Target name: $FILE_NAME"
echo ""

# Step 1: Get service role key from Management API
echo -e "${YELLOW}🔑 Getting service role key...${NC}"
SERVICE_ROLE_KEY=$(curl -s -X GET \
  "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" | jq -r '.[] | select(.name == "service_role") | .api_key')

if [ -z "$SERVICE_ROLE_KEY" ] || [ "$SERVICE_ROLE_KEY" == "null" ]; then
    echo -e "${RED}❌ Failed to get service role key${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Got service role key${NC}"

# Step 2: Check if bucket exists, create if not
echo -e "${YELLOW}📦 Checking if bucket exists...${NC}"
BUCKET_CHECK=$(curl -s -X GET \
  "${SUPABASE_URL}/storage/v1/bucket/${BUCKET_NAME}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json")

if echo "$BUCKET_CHECK" | grep -q "Bucket not found"; then
    echo -e "${YELLOW}📦 Creating bucket '${BUCKET_NAME}'...${NC}"
    CREATE_RESULT=$(curl -s -X POST \
      "${SUPABASE_URL}/storage/v1/bucket" \
      -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"id\": \"${BUCKET_NAME}\", \"name\": \"${BUCKET_NAME}\", \"public\": true}")
    
    if echo "$CREATE_RESULT" | grep -q "error"; then
        echo -e "${RED}❌ Failed to create bucket: $CREATE_RESULT${NC}"
        exit 1
    fi
    echo -e "${GREEN}✅ Bucket created successfully${NC}"
else
    echo -e "${GREEN}✅ Bucket already exists${NC}"
fi

# Step 3: Upload file
echo -e "${YELLOW}📤 Uploading file...${NC}"
UPLOAD_RESULT=$(curl -s -X POST \
  "${SUPABASE_URL}/storage/v1/object/${BUCKET_NAME}/${FILE_NAME}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: image/png" \
  -H "x-upsert: true" \
  --data-binary "@${FILE_PATH}")

if echo "$UPLOAD_RESULT" | grep -q "error"; then
    echo -e "${RED}❌ Upload failed: $UPLOAD_RESULT${NC}"
    exit 1
fi

echo -e "${GREEN}✅ File uploaded successfully${NC}"

# Step 4: Generate public URL
PUBLIC_URL="${SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/${FILE_NAME}"

echo ""
echo "================================================"
echo -e "${GREEN}🎉 SUCCESS!${NC}"
echo ""
echo -e "${GREEN}📍 Public URL:${NC}"
echo "$PUBLIC_URL"
echo ""
echo -e "${GREEN}📋 Copy this URL:${NC}"
echo "$PUBLIC_URL" | pbcopy 2>/dev/null && echo "(Copied to clipboard!)" || echo ""
echo "================================================"
