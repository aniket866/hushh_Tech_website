#!/bin/bash
# Refresh Vertex AI OAuth Token for Supabase Edge Functions
# This script should be run every 50 minutes via cron or Cloud Scheduler
# 
# Usage: ./scripts/refresh-vertex-ai-token.sh
#
# Prerequisites:
# 1. gcloud CLI installed and authenticated
# 2. Supabase CLI installed and logged in
# 3. Service account with Vertex AI User role

set -e

echo "🔄 Refreshing GCP Access Token for Vertex AI..."

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI not found. Please install Google Cloud SDK."
    exit 1
fi

# Check if supabase is installed
if ! command -v supabase &> /dev/null; then
    echo "❌ supabase CLI not found. Please install Supabase CLI."
    exit 1
fi

# Get new access token
echo "📝 Getting fresh access token from gcloud..."
GCP_TOKEN=$(gcloud auth print-access-token 2>/dev/null)

if [ -z "$GCP_TOKEN" ]; then
    echo "❌ Failed to get access token. Make sure you're logged into gcloud."
    echo "   Run: gcloud auth login"
    exit 1
fi

# Validate token (first 10 chars for security)
TOKEN_PREVIEW="${GCP_TOKEN:0:10}..."
echo "✅ Got token: ${TOKEN_PREVIEW}"

# Update Supabase secret
echo "📤 Updating Supabase secret GCP_ACCESS_TOKEN..."
cd "$(dirname "$0")/.." || exit 1
supabase secrets set GCP_ACCESS_TOKEN="$GCP_TOKEN"

echo "✅ Token refreshed successfully!"
echo ""
echo "📌 Note: Token expires in 1 hour. Set up a cron job to run this every 50 minutes:"
echo "   */50 * * * * /path/to/hushhTech/scripts/refresh-vertex-ai-token.sh"
echo ""
echo "🔗 Or use Google Cloud Scheduler for production environments."
