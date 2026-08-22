#!/bin/bash
# Setup Google Cloud Scheduler for Vertex AI Token Refresh (Production)
# This creates a Cloud Scheduler job that triggers a Cloud Function every 50 minutes
# The Cloud Function refreshes the Supabase secret with a new GCP access token
#
# Usage: ./scripts/setup-cloud-scheduler-token-refresh.sh
#
# Prerequisites:
# 1. gcloud CLI installed and authenticated with project owner permissions
# 2. Service Account with Vertex AI User role
# 3. Supabase CLI access configured

set -e

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-hushone-app}"
REGION="us-central1"
SCHEDULER_NAME="vertex-ai-token-refresh"
FUNCTION_NAME="vertex-ai-token-refresh"
SERVICE_ACCOUNT="vertex-ai-token-refresher@${PROJECT_ID}.iam.gserviceaccount.com"

# Supabase configuration
SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF:-ibsisfnjxeowvdtvgzff}"
SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"

echo "🔧 Setting up Google Cloud Scheduler for Vertex AI Token Refresh"
echo "=================================================================="
echo ""
echo "📌 Configuration:"
echo "   Project ID: $PROJECT_ID"
echo "   Region: $REGION"
echo "   Scheduler: $SCHEDULER_NAME"
echo "   Cloud Function: $FUNCTION_NAME"
echo ""

# Check prerequisites
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI not found. Please install Google Cloud SDK."
    exit 1
fi

# Set project
gcloud config set project "$PROJECT_ID"

# Enable required APIs
echo "🔌 Enabling required APIs..."
gcloud services enable cloudfunctions.googleapis.com
gcloud services enable cloudscheduler.googleapis.com
gcloud services enable secretmanager.googleapis.com
gcloud services enable iamcredentials.googleapis.com

# Create service account if it doesn't exist
echo "👤 Setting up service account..."
if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT" &>/dev/null; then
    gcloud iam service-accounts create vertex-ai-token-refresher \
        --display-name="Vertex AI Token Refresher" \
        --description="Service account for refreshing Vertex AI OAuth tokens"
fi

# Grant required permissions
echo "🔑 Granting permissions..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SERVICE_ACCOUNT" \
    --role="roles/aiplatform.user" \
    --quiet

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SERVICE_ACCOUNT" \
    --role="roles/iam.serviceAccountTokenCreator" \
    --quiet

# Create the Cloud Function code
echo "📝 Creating Cloud Function code..."
FUNCTION_DIR="/tmp/vertex-ai-token-refresh-function"
rm -rf "$FUNCTION_DIR"
mkdir -p "$FUNCTION_DIR"

# Create package.json
cat > "$FUNCTION_DIR/package.json" << 'EOF'
{
  "name": "vertex-ai-token-refresh",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "@google-cloud/functions-framework": "^3.0.0",
    "google-auth-library": "^9.0.0",
    "node-fetch": "^2.6.7"
  }
}
EOF

# Create the function code
cat > "$FUNCTION_DIR/index.js" << 'EOF'
const { GoogleAuth } = require('google-auth-library');
const fetch = require('node-fetch');

/**
 * Cloud Function to refresh Vertex AI token and update Supabase secret
 * Triggered by Cloud Scheduler every 50 minutes
 */
exports.refreshVertexAIToken = async (req, res) => {
  console.log('🔄 Starting Vertex AI token refresh...');
  
  try {
    // Get a fresh access token using Application Default Credentials
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse.token;
    
    if (!accessToken) {
      throw new Error('Failed to get access token from GCP');
    }
    
    console.log('✅ Got fresh access token from GCP');
    
    // Get Supabase credentials from environment or Secret Manager
    const supabaseAccessToken = process.env.SUPABASE_ACCESS_TOKEN;
    const supabaseProjectRef = process.env.SUPABASE_PROJECT_REF || 'ibsisfnjxeowvdtvgzff';
    
    if (!supabaseAccessToken) {
      throw new Error('SUPABASE_ACCESS_TOKEN environment variable not set');
    }
    
    // Update Supabase secret via Management API
    const supabaseUrl = `https://api.supabase.com/v1/projects/${supabaseProjectRef}/secrets`;
    
    const updateResponse = await fetch(supabaseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([
        {
          name: 'GCP_ACCESS_TOKEN',
          value: accessToken
        }
      ])
    });
    
    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      throw new Error(`Failed to update Supabase secret: ${updateResponse.status} - ${errorText}`);
    }
    
    console.log('✅ Successfully updated Supabase GCP_ACCESS_TOKEN secret');
    
    res.status(200).json({
      success: true,
      message: 'Token refreshed successfully',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Token refresh failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};
EOF

echo "✅ Cloud Function code created"

# Store Supabase access token in Secret Manager
echo "🔐 Setting up Secret Manager..."
if [ -n "$SUPABASE_ACCESS_TOKEN" ]; then
    echo -n "$SUPABASE_ACCESS_TOKEN" | gcloud secrets create supabase-access-token --data-file=- 2>/dev/null || \
    echo -n "$SUPABASE_ACCESS_TOKEN" | gcloud secrets versions add supabase-access-token --data-file=-
    
    # Grant the Cloud Function access to the secret
    gcloud secrets add-iam-policy-binding supabase-access-token \
        --member="serviceAccount:$SERVICE_ACCOUNT" \
        --role="roles/secretmanager.secretAccessor"
else
    echo "⚠️  SUPABASE_ACCESS_TOKEN not set. You need to set it manually:"
    echo "   1. Get your Supabase access token from https://supabase.com/dashboard/account/tokens"
    echo "   2. Run: echo 'YOUR_TOKEN' | gcloud secrets create supabase-access-token --data-file=-"
fi

# Deploy the Cloud Function
echo "🚀 Deploying Cloud Function..."
cd "$FUNCTION_DIR"

gcloud functions deploy "$FUNCTION_NAME" \
    --gen2 \
    --runtime=nodejs20 \
    --region="$REGION" \
    --source=. \
    --entry-point=refreshVertexAIToken \
    --trigger-http \
    --allow-unauthenticated \
    --service-account="$SERVICE_ACCOUNT" \
    --memory=256MB \
    --timeout=60s \
    --set-env-vars="SUPABASE_PROJECT_REF=$SUPABASE_PROJECT_REF" \
    --set-secrets="SUPABASE_ACCESS_TOKEN=supabase-access-token:latest"

FUNCTION_URL=$(gcloud functions describe "$FUNCTION_NAME" --region="$REGION" --gen2 --format="value(serviceConfig.uri)")
echo "✅ Cloud Function deployed at: $FUNCTION_URL"

# Create Cloud Scheduler job
echo "⏰ Creating Cloud Scheduler job..."

# Delete existing job if it exists
gcloud scheduler jobs delete "$SCHEDULER_NAME" --location="$REGION" --quiet 2>/dev/null || true

# Create new scheduler job (every 50 minutes)
gcloud scheduler jobs create http "$SCHEDULER_NAME" \
    --location="$REGION" \
    --schedule="*/50 * * * *" \
    --uri="$FUNCTION_URL" \
    --http-method=POST \
    --oidc-service-account-email="$SERVICE_ACCOUNT" \
    --time-zone="UTC" \
    --description="Refreshes Vertex AI OAuth token every 50 minutes to prevent expiry"

echo "✅ Cloud Scheduler job created"

# Run the job immediately to verify
echo ""
echo "🧪 Running initial token refresh..."
gcloud scheduler jobs run "$SCHEDULER_NAME" --location="$REGION"

echo ""
echo "=================================================================="
echo "✅ PRODUCTION SETUP COMPLETE!"
echo ""
echo "📌 Summary:"
echo "   Cloud Function: $FUNCTION_URL"
echo "   Scheduler: Every 50 minutes"
echo "   Service Account: $SERVICE_ACCOUNT"
echo ""
echo "📋 View logs:"
echo "   gcloud functions logs read $FUNCTION_NAME --region=$REGION --gen2"
echo ""
echo "🛑 To disable:"
echo "   gcloud scheduler jobs pause $SCHEDULER_NAME --location=$REGION"
echo ""
echo "▶️  To re-enable:"
echo "   gcloud scheduler jobs resume $SCHEDULER_NAME --location=$REGION"
