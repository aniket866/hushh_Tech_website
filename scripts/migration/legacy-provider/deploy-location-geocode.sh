#!/bin/bash

# Deploy the hushh-location-geocode Edge Function
# This function uses Google Geocoding API for GPS-based reverse geocoding

echo "🚀 Deploying hushh-location-geocode Edge Function..."

# Deploy the function
npx supabase functions deploy hushh-location-geocode --project-ref ibsisfnjxeowvdtvgzff

echo ""
echo "✅ Deployment complete!"
echo ""
echo "⚠️  IMPORTANT: Make sure to set the GOOGLE_MAPS_API_KEY secret:"
echo "   npx supabase secrets set GOOGLE_MAPS_API_KEY=your_api_key --project-ref ibsisfnjxeowvdtvgzff"
echo ""
echo "📝 Also run the database migration in Supabase Dashboard SQL Editor:"
echo "   supabase/migrations/20260127200000_add_gps_location_columns.sql"
