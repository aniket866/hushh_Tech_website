#!/bin/bash

# Test script for hushh-address-inference Edge Function
# This tests the lightweight address inference API

echo "🧪 Testing hushh-address-inference Edge Function"
echo "================================================"
echo ""

SUPABASE_URL="https://ibsisfnjxeowvdtvgzff.supabase.co"
FUNCTION_URL="${SUPABASE_URL}/functions/v1/hushh-address-inference"

# Test 1: Indian name
echo "📍 Test 1: Indian name pattern detection"
echo "Name: Ankit Kumar Singh"
echo ""

curl -s -X POST "${FUNCTION_URL}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ankit Kumar Singh",
    "email": "ankit@hushh.ai"
  }' | jq '.'

echo ""
echo "---"
echo ""

# Test 2: American name with corporate email
echo "📍 Test 2: American name with corporate email"
echo "Name: John Smith"
echo "Email: john.smith@google.com"
echo ""

curl -s -X POST "${FUNCTION_URL}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Smith",
    "email": "john.smith@google.com"
  }' | jq '.'

echo ""
echo "---"
echo ""

# Test 3: Chinese name pattern
echo "📍 Test 3: Chinese name pattern detection"
echo "Name: Wei Chen"
echo ""

curl -s -X POST "${FUNCTION_URL}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Wei Chen",
    "email": "wei.chen@gmail.com"
  }' | jq '.'

echo ""
echo "---"
echo ""

# Test 4: Famous person (should find via Google Search grounding)
echo "📍 Test 4: Famous person (Elon Musk - should use Google Search)"
echo ""

curl -s -X POST "${FUNCTION_URL}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Elon Musk",
    "email": "elon@tesla.com"
  }' | jq '.'

echo ""
echo "================================================"
echo "✅ Tests completed!"
echo ""
echo "Expected response time: 5-10 seconds per request"
echo "Compare to hushh-profile-search: 30-60 seconds"
