/**
 * KYC Flow Page
 * 
 * Main entry point for the 5-screen KYC UX flow.
 * This page can be accessed directly or embedded in bank partner apps.
 * 
 * URL Parameters:
 * - bankId: Relying party ID (e.g., "hdfc-bank")
 * - bankName: Display name for the bank (e.g., "HDFC Bank")
 * - demo: Enable demo mode (true/false)
 * 
 * Example URLs:
 * - /kyc-flow (default demo mode)
 * - /kyc-flow?bankId=hdfc-bank&bankName=HDFC%20Bank
 * - /kyc-flow?demo=true
 */
'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Box, Center, Spinner, Text, VStack, Badge } from '@chakra-ui/react';
import { Helmet } from 'react-helmet';
import KycFlowContainer from '../../components/kyc/screens/KycFlowContainer';
import { KycCheckResponse } from '../../types/kyc';
import HushhTechHeader from '../../components/hushh-tech-header/HushhTechHeader';
import Footer from '../../components/Footer';
import config from '../../resources/config/config';

// =====================================================
// Page Configuration
// =====================================================

const DEFAULT_BANK_ID = 'demo-bank';
const DEFAULT_BANK_NAME = 'Demo Bank';

// =====================================================
// Loading Component
// =====================================================

const LoadingScreen: React.FC = () => (
  <Box
    minH="100vh"
    bg="white"
  >
    <Center h="100vh">
      <VStack spacing={4} role="status" aria-live="polite">
        <Spinner
          size="xl"
          color="gray.600"
          thickness="3px"
          speed="0.8s"
        />
        <Text color="gray.500" fontSize="sm">
          Initializing KYC verification...
        </Text>
      </VStack>
    </Center>
  </Box>
);

// =====================================================
// KYC Flow Page Component
// =====================================================

const KycFlowPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [isReady, setIsReady] = useState(false);
  const [userId, setUserId] = useState<string>('');
  const [userEmail, setUserEmail] = useState<string | undefined>(undefined);
  
  // Extract URL parameters
  const bankId = searchParams.get('bankId') || DEFAULT_BANK_ID;
  const bankName = searchParams.get('bankName') || DEFAULT_BANK_NAME;
  const isDemo = searchParams.get('demo') === 'true' || bankId === 'demo-bank';
  
  // Initialize on mount — get authenticated user for Plaid financial verification
  useEffect(() => {
    const init = async () => {
      try {
        if (config.gcpBackendClient) {
          const { data: { user } } = await config.gcpBackendClient.auth.getUser();
          if (user) {
            setUserId(user.id);
            setUserEmail(user.email || undefined);
          } else {
            // Use a demo user ID if not authenticated
            setUserId(`demo-user-${Date.now()}`);
          }
        } else {
          setUserId(`demo-user-${Date.now()}`);
        }
      } catch {
        setUserId(`demo-user-${Date.now()}`);
      }
      setIsReady(true);
    };
    
    init();
  }, []);
  
  // Handle flow completion
  const handleComplete = (response: KycCheckResponse) => {
    console.log('KYC Flow Complete:', response);
    
    // In production, this would redirect back to the bank's app
    // For demo, show completion message
    if (isDemo) {
      console.log('Demo mode - flow complete. Status:', response.status);
    } else {
      // Redirect to success page or callback URL
      const callbackUrl = searchParams.get('callback');
      if (callbackUrl) {
        window.location.href = `${callbackUrl}?status=${response.status}&checkId=${response.checkId}`;
      }
    }
  };
  
  // Handle "Start Full KYC" action
  const handleStartFullKyc = () => {
    console.log('Starting full KYC flow...');
    
    // In production, redirect to full KYC form
    // For demo, navigate to KYC form page if it exists
    if (isDemo) {
      alert('Demo: This would redirect to the full KYC document upload flow.');
    } else {
      navigate('/kyc-form');
    }
  };
  
  // Show loading screen while initializing
  if (!isReady) {
    return <LoadingScreen />;
  }
  
  return (
    <>
      {/* SEO Meta Tags */}
      <Helmet>
        <title>KYC Verification | Hushh Smart KYC</title>
        <meta 
          name="description" 
          content="Complete your KYC verification with Hushh's AI-powered smart KYC network. Reuse existing verifications and skip redundant document uploads."
        />
        <meta name="robots" content="noindex, nofollow" />
        <meta property="og:title" content="KYC Verification | Hushh" />
        <meta 
          property="og:description" 
          content="Fast, secure KYC verification powered by A2A agent collaboration."
        />
      </Helmet>
      
      {/* Page Layout */}
      <Box minH="100vh" bg="white">
        <HushhTechHeader />
        <Box pb="40px">
          {isDemo && (
            <Center pt={6} pb={2}>
              <Badge 
                colorScheme="purple" 
                variant="subtle" 
                px={4} 
                py={1} 
                borderRadius="full"
                fontSize="xs"
                fontWeight="600"
                letterSpacing="wider"
              >
                KYC DEMO SESSION
              </Badge>
            </Center>
          )}
          {/* KYC Flow Container */}
          <KycFlowContainer
            relyingPartyId={bankId}
            bankName={bankName}
            userId={userId}
            userEmail={userEmail}
            onComplete={handleComplete}
            onStartFullKyc={handleStartFullKyc}
          />
        </Box>
        <Footer />
      </Box>
    </>
  );
};

export default KycFlowPage;
