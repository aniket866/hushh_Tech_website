#!/bin/bash
# Test script for hushh-profile-search API
# Exact same functionality as the React app

GCP_BASE_URL="${GCP_BASE_URL:-${VITE_GCP_API_BASE_URL:-}}"
ANON_KEY="${FIREBASE_ID_TOKEN:-${FIREBASE_ID_TOKEN:-}}"

if [ -z "$GCP_BASE_URL" ] || [ -z "$ANON_KEY" ]; then
  echo "❌ Set GCP_BASE_URL/FIREBASE_ID_TOKEN or VITE_GCP_API_BASE_URL/FIREBASE_ID_TOKEN before running this script."
  exit 1
fi

echo "🔍 Testing Hushh Profile Search API..."
echo ""

# Test with sample data
curl -X POST "${GCP_BASE_URL}/functions/v1/hushh-profile-search" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Elon Musk",
    "email": "elon@tesla.com",
    "country": "United States",
    "contact": "+1234567890"
  }' | jq .

echo ""
echo "✅ Test complete!"
echo ""
echo "API Endpoint: ${GCP_BASE_URL}/functions/v1/hushh-profile-search"
echo "Method: POST"
echo "Required fields: name, email"
echo "Optional fields: country, contact"
