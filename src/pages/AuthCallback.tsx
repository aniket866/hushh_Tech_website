import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Container, Heading, Text, Spinner, Button, Flex, Icon, Alert, AlertIcon } from '@chakra-ui/react';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import config from '../resources/config/config';
import { DEFAULT_AUTH_REDIRECT, sanitizeInternalRedirect } from '../utils/security';
import { useAuthSession } from '../auth/AuthSessionProvider';
import { normalizeLegacyOnboardingRedirectTarget } from '../services/onboarding/flow';
import { fetchResolvedOnboardingProgress } from '../services/onboarding/progress';
import {
  getInvestorAccessState,
  getResumeRouteForState,
} from '../services/investorAccess/state';


const AuthCallback: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { revalidateSession } = useAuthSession();
  const [verificationStatus, setVerificationStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Get custom redirect from URL param (for Hushh AI and other modules)
  const redirectParam = searchParams.get('redirect');
  const customRedirect = redirectParam
    ? normalizeLegacyOnboardingRedirectTarget(
        sanitizeInternalRedirect(redirectParam, DEFAULT_AUTH_REDIRECT)
      )
    : null;

  // Helper to determine final redirect destination. Honors the full
  // investor access state machine so paid/verified/rejected/refunded users
  // land directly on the right surface (preventing the old "flash of
  // profile then bounce" UX).
  const getRedirectDestination = (
    onboarding: { is_completed: boolean; current_step: number | null; fund_payment_status: string | null; fund_investor_verification_status: string | null } | null,
  ): string => {
    if (customRedirect) return customRedirect;
    const state = getInvestorAccessState(onboarding);
    return getResumeRouteForState(state, onboarding?.current_step);
  };

  const queueWelcomeToast = (userId?: string | null) => {
    sessionStorage.setItem('showWelcomeToast', 'true');
    if (userId) {
      sessionStorage.setItem('showWelcomeToastUserId', userId);
      return;
    }
    sessionStorage.removeItem('showWelcomeToastUserId');
  };

  useEffect(() => {
    const handleEmailVerification = async () => {
      try {
        const gcpBackend = config.gcpBackendClient;
        if (!gcpBackend) {
          setVerificationStatus('error');
          setErrorMessage('Configuration error');
          console.error('[Hushh][AuthCallback] GcpBackend client missing - cannot restore session');
          return;
        }

        // Always clear stale toast flags; set again only on successful auth restore.
        sessionStorage.removeItem('showWelcomeToast');
        sessionStorage.removeItem('showWelcomeToastUserId');

        // Check for any type and error from the URL
        const type = searchParams.get('type');
        const error = searchParams.get('error');
        const errorDescription = searchParams.get('error_description');
        const code = searchParams.get('code');
        console.info('[Hushh][AuthCallback] Callback hit', { type, hasCode: !!code, hasError: !!error, customRedirect });

        // If there's an error, display it
        if (error) {
          setVerificationStatus('error');
          setErrorMessage(errorDescription || 'An error occurred during verification');
          console.error('[Hushh][AuthCallback] OAuth error', { error, errorDescription });
          return;
        }

        // Always exchange an OAuth code when present. A stale cached session must not
        // block the new Apple/Google identity from becoming the active session.
        if (code) {
          const { error: exchangeError } = await gcpBackend.auth.exchangeCodeForSession(code);
          if (exchangeError) {
            setVerificationStatus('error');
            setErrorMessage(exchangeError.message);
            console.error('[Hushh][AuthCallback] Code exchange failed', exchangeError);
            return;
          }
          console.info('[Hushh][AuthCallback] Code exchange succeeded, session created');

          // Clean the URL to avoid re-exchanging the same code on refresh
          const cleanUrl = window.location.origin + window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);
        }

        // If it's a signup confirmation
        if (type === 'signup') {
          // Get the access token and refresh token from the URL
          const accessToken = searchParams.get('access_token');
          const refreshToken = searchParams.get('refresh_token');

          if (!accessToken || !refreshToken) {
            setVerificationStatus('error');
            setErrorMessage('Missing authentication tokens');
            console.error('[Hushh][AuthCallback] Missing tokens in signup callback');
            return;
          }

          // Set the session with GcpBackend
          const { error } = await gcpBackend.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken
          });

          if (error) {
            setVerificationStatus('error');
            setErrorMessage(error.message);
            console.error('[Hushh][AuthCallback] setSession failed', error);
            return;
          }
        }

        const sessionSnapshot = await revalidateSession();

        if (sessionSnapshot.status !== 'authenticated' || !sessionSnapshot.user) {
          setVerificationStatus('error');
          setErrorMessage('No active session found. Please try signing in again.');
          console.error('[Hushh][AuthCallback] No valid session after callback', sessionSnapshot);
          return;
        }

        const user = sessionSnapshot.user;
        const onboardingData = await fetchResolvedOnboardingProgress(
          gcpBackend,
          user.id,
        );

        console.info('[Hushh][AuthCallback] Session restored', {
          userId: user.id,
          email: user.email,
          onboardingFound: !!onboardingData,
          investorAccessState: getInvestorAccessState(onboardingData),
        });

        queueWelcomeToast(user.id);
        setVerificationStatus('success');
        setTimeout(() => {
          navigate(getRedirectDestination(onboardingData));
        }, 1200);
      } catch (err) {
        console.error('Verification error:', err);
        setVerificationStatus('error');
        setErrorMessage('An unexpected error occurred');
      }
    };

    handleEmailVerification();
  }, [searchParams, navigate, revalidateSession]);

  const redirectToLogin = () => {
    navigate('/login');
  };

  const redirectToHome = () => {
    navigate('/');
  };

  return (
    <Container maxW="container.md" py={12}>
      <Box
        borderWidth="1px"
        borderRadius="lg"
        p={8}
        boxShadow="lg"
        bg="white"
        textAlign="center"
      >
        {verificationStatus === 'loading' && (
          <Flex direction="column" align="center" py={10}>
            <Spinner size="xl" color="#0AADBC" thickness="4px" speed="0.65s" mb={6} />
            <Heading size="lg" mb={4}>Verifying your email...</Heading>
            <Text color="gray.600">Please wait while we confirm your email address.</Text>
          </Flex>
        )}

        {verificationStatus === 'success' && (
          <Flex direction="column" align="center" py={6}>
            <Icon as={CheckCircle} w={16} h={16} color="green.500" mb={6} />
            <Heading size="lg" mb={4}>Welcome to HushhTech!</Heading>
            <Text color="gray.600" mb={8}>
              Your email has been successfully verified. You can now set up your profile and start exploring the community.
            </Text>
            <Flex gap={4}>
              <Button
                colorScheme="green"
                size="lg"
                onClick={() => navigate('/user-registration')}
              >
                Set us your profile
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => navigate('/community')}
              >
                Checkout communnity posts
              </Button>
            </Flex>
          </Flex>
        )}

        {verificationStatus === 'error' && (
          <Flex direction="column" align="center" py={6}>
            <Icon as={AlertTriangle} w={16} h={16} color="red.500" mb={6} />
            <Heading size="lg" mb={4}>Verification Failed</Heading>
            <Alert status="error" mb={6}>
              <AlertIcon />
              {errorMessage || 'There was an error verifying your email. Please try again.'}
            </Alert>
            <Flex gap={4}>
              <Button
                colorScheme="blue"
                size="lg"
                onClick={redirectToLogin}
              >
                Try Logging In
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={redirectToHome}
              >
                Go to Home
              </Button>
            </Flex>
          </Flex>
        )}
      </Box>
    </Container>
  );
};

export default AuthCallback;
