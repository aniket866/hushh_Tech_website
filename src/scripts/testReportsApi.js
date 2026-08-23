/**
 * This is a simple test script to verify the Reports API connection
 * Run with: node src/scripts/testReportsApi.js
 */

const MARKET_GCP_API_BASE_URL =
  process.env.MARKET_GCP_API_BASE_URL || process.env.VITE_MARKET_GCP_API_BASE_URL || '';
const API_BASE_URL =
  process.env.MARKET_GCS_PUBLIC_API_BASE_URL ||
  process.env.MARKET_GCS_PUBLIC_API_BASE ||
  (MARKET_GCP_API_BASE_URL ? `${MARKET_GCP_API_BASE_URL}/rest/v1` : '');
const API_KEY =
  process.env.MARKET_FIREBASE_API_KEY ||
  process.env.VITE_MARKET_GCS_PUBLIC_KEY ||
  '';

// Storage bucket URLs for testing images and videos
const STORAGE_BUCKETS = {
  IMAGES: '/api/gcp/storage/alohafundsreport-images',
  VIDEOS: '/api/gcp/storage/alohafundsreport-videos'
};

async function testApiConnection() {
  try {
    if (!API_BASE_URL || !API_KEY) {
      throw new Error('Set MARKET_GCS_PUBLIC_API_BASE_URL and MARKET_FIREBASE_API_KEY before running this script.');
    }

    console.log('Testing API connection with updated key...');
    
    // Test the GET All Reports endpoint with API key as query parameter per documentation
    console.log('\n1. Testing GET All Reports endpoint:');
    const response = await fetch(
      `${API_BASE_URL}/reports?select=*&limit=1&apikey=${API_KEY}`,
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Response status:', response.status);
    console.log('Response statusText:', response.statusText);
    
    if (!response.ok) {
      console.error(`API request failed with status ${response.status}: ${response.statusText}`);
      const errorText = await response.text();
      console.error('Error details:', errorText);
      return;
    }
    
    const data = await response.json();
    console.log('Data received:', JSON.stringify(data, null, 2));
    console.log('API connection test successful!');
    
    // Test getting a single report by ID
    if (data && data.length > 0) {
      const reportId = data[0].id;
      console.log(`\n2. Testing GET Single Report endpoint with ID: ${reportId}`);
      
      const singleReportResponse = await fetch(
        `${API_BASE_URL}/reports?id=eq.${reportId}&select=*&apikey=${API_KEY}`,
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (singleReportResponse.ok) {
        const reportData = await singleReportResponse.json();
        console.log('Single report data received:', JSON.stringify(reportData, null, 2));
      } else {
        console.error(`Failed to fetch single report: ${singleReportResponse.status}`);
      }
    }
    
    // Test with count query
    console.log('\n3. Testing count of available reports...');
    const countResponse = await fetch(
      `${API_BASE_URL}/reports?select=id&order=date.desc&apikey=${API_KEY}`,
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (countResponse.ok) {
      const countData = await countResponse.json();
      console.log(`Total available reports: ${countData.length}`);
    } else {
      console.error('Failed to get report count');
    }
    
    // Test storage URLs
    console.log('\n4. Testing storage URL patterns:');
    console.log(`Images bucket URL: ${STORAGE_BUCKETS.IMAGES}`);
    console.log(`Videos bucket URL: ${STORAGE_BUCKETS.VIDEOS}`);
    
    // Example of URL pattern for images
    if (data && data.length > 0) {
      const userId = `user_${data[0].id.slice(0, 8)}`;
      console.log(`\nExample image URL pattern for user ${userId}:`);
      console.log(`${STORAGE_BUCKETS.IMAGES}/reports/${userId}/timestamp_filename.jpg`);
    }
    
  } catch (error) {
    console.error('Error testing API connection:', error);
  }
}

testApiConnection(); 
