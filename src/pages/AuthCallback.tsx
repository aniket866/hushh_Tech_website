import React, { useEffect, useRef, useState } from 'react';
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
  const [errorHeading, setErrorHeading] = useState('Sign-in Failed');
  const callbackHandledRef = useRef(false);

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
    const handleFirebaseRedirect = async () => {
      if (callbackHandledRef.current) {
        return;
      }
      callbackHandledRef.current = true;

      let sessionRestored = false;

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

        // Preserve provider error details if Firebase's redirect handler puts
        // them in the URL. Normal Firebase errors are returned by
        // gcpBackend.auth.getRedirectResult().
        const error = searchParams.get('error');
        const errorDescription = searchParams.get('error_description');
        console.info('[Hushh][AuthCallback] Callback hit', { hasError: !!error, customRedirect });

        // If there's an error, display it
        if (error) {
          setVerificationStatus('error');
          setErrorMessage(errorDescription || 'An error occurred during verification');
          console.error('[Hushh][AuthCallback] OAuth error', { error, errorDescription });
          return;
        }

        const { error: redirectError } = await gcpBackend.auth.getRedirectResult();
        if (redirectError) {
          setVerificationStatus('error');
          setErrorMessage(redirectError.message);
          console.error('[Hushh][AuthCallback] Firebase redirect failed', redirectError);
          return;
        }

        // Firebase consumes the redirect result once. Remove callback state
        // from the address bar after the result has been processed.
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);

        const sessionSnapshot = await revalidateSession();

        if (sessionSnapshot.status !== 'authenticated' || !sessionSnapshot.user) {
          setVerificationStatus('error');
          setErrorMessage('No active session found. Please try signing in again.');
          console.error('[Hushh][AuthCallback] No valid session after callback', sessionSnapshot);
          return;
        }

        const user = sessionSnapshot.user;
        sessionRestored = true;
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
        if (sessionRestored) {
          setErrorHeading('Account setup unavailable');
          const failure = err as { code?: string; message?: string } | null;
          const identityFailure = ['IDENTITY_CREATION_DISABLED', 'IDENTITY_EVIDENCE_UNAVAILABLE', 'IDENTITY_REVIEW_REQUIRED', 'IDENTITY_DENIED'].includes(failure?.code || '');
          setErrorMessage(identityFailure && typeof failure?.message === 'string'
            ? failure.message
            : 'Your sign-in succeeded, but we could not load your application account. Please retry or contact support.');
        } else {
          setErrorMessage('An unexpected error occurred');
        }
      }
    };

    handleFirebaseRedirect();
  }, [searchParams, navigate, revalidateSession]);

  const redirectToLogin = () => {
    navigate('/login');
  };

  const redirectToHome = () => {
    navigate('/');
  };

  // Keep the existing callback lifecycle; only suppress its transient UI.
  if (['loading', 'success'].includes(verificationStatus)) {
    return <span className="sr-only" role="status">Signing in</span>;
  }

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
            <Heading size="lg" mb={4}>Completing secure sign-in...</Heading>
            <Text color="gray.600">Please wait while we finish your Apple or Google sign-in.</Text>
          </Flex>
        )}

        {verificationStatus === 'success' && (
          <Flex direction="column" align="center" py={6}>
            <Icon as={CheckCircle} w={16} h={16} color="green.500" mb={6} />
            <Heading size="lg" mb={4}>Welcome to HushhTech!</Heading>
            <Text color="gray.600" mb={8}>
              Your account is ready. You can now set up your profile and start exploring the community.
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
            <Heading size="lg" mb={4}>{errorHeading}</Heading>
            <Alert status="error" mb={6}>
              <AlertIcon />
              {errorMessage || 'There was an error completing sign-in. Please try again.'}
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
