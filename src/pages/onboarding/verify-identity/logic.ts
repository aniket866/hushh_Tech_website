import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@chakra-ui/react';
import config from '../../../resources/config/config';
import { useAuthSession } from '../../../auth/AuthSessionProvider';
import { buildLoginRedirectPath } from '../../../auth/routePolicy';
import { upsertOnboardingData } from '../../../services/onboarding/upsertOnboardingData';
import { CONSENT_VERSION } from '../../../services/consent/consentConfig';

export interface OnboardingData {
  legal_first_name?: string;
  legal_last_name?: string;
  email?: string;
  phone_number?: string;
  phone_country_code?: string;
  is_identity_verified?: boolean;
  identity_verified_at?: string;
}

export interface VerificationStatus {
  status: 'not_started' | 'pending' | 'processing' | 'verified' | 'requires_input' | 'failed';
  document_verified: boolean;
  selfie_verified: boolean;
  email_verified: boolean;
  phone_verified: boolean;
}

export function useVerifyIdentityLogic() {
  const navigate = useNavigate();
  const toast = useToast();
  const { session, status, user } = useAuthSession();
  const [loading, setLoading] = useState(true);
  const [startingVerification, setStartingVerification] = useState(false);
  const [onboardingData, setOnboardingData] = useState<OnboardingData | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<VerificationStatus>({
    status: 'not_started',
    document_verified: false,
    selfie_verified: false,
    email_verified: false,
    phone_verified: false,
  });

  // Legal consent checkpoint (mirrors the financial-link / step-9 pattern).
  const [identityConsentChecked, setIdentityConsentChecked] = useState(false);
  const [identityConsentPersisted, setIdentityConsentPersisted] = useState(false);
  const [identityConsentError, setIdentityConsentError] = useState(false);

  // Explicit defer ("I'll do this later") confirm modal.
  const [isSkipConfirmOpen, setIsSkipConfirmOpen] = useState(false);
  const [isSkipping, setIsSkipping] = useState(false);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (status === 'booting') {
      return;
    }

    if (!config.gcpBackendClient) {
      toast({
        title: 'Error',
        description: 'Configuration error',
        status: 'error',
        duration: 5000,
      });
      setLoading(false);
      return;
    }

    if (status !== 'authenticated' || !user) {
      navigate(buildLoginRedirectPath('/onboarding/verify'), { replace: true });
      setLoading(false);
      return;
    }

    const loadUserData = async () => {
      try {
        const { data: onboarding } = await config.gcpBackendClient
          .from('onboarding_data')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (onboarding) {
          setOnboardingData(onboarding);

          // Pre-check consent for a returning user (don't re-prompt).
          if (onboarding.identity_consent_at) {
            setIdentityConsentChecked(true);
            setIdentityConsentPersisted(true);
          }

          // If already verified, redirect to profile
          if (onboarding.identity_verified) {
            navigate('/hushh-user-profile');
            return;
          }
        }

        // Check existing verification status
        const { data: verification } = await config.gcpBackendClient
          .from('identity_verifications')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (verification) {
          setVerificationStatus({
            status: verification.stripe_status || 'not_started',
            document_verified: verification.document_verified || false,
            selfie_verified: verification.selfie_verified || false,
            email_verified: verification.email_verified || false,
            phone_verified: verification.phone_verified || false,
          });

          // If verified, redirect
          if (verification.stripe_status === 'verified') {
            navigate('/hushh-user-profile');
            return;
          }
        }
      } catch (error) {
        console.error('Error loading data:', error);
      } finally {
        setLoading(false);
      }
    };

    void loadUserData();
  }, [navigate, status, toast, user]);

  /* Record the identity-verification consent once, BEFORE the Stripe session is
     created. Reuses the onboarding_data row; upsert silently drops the column if
     the migration hasn't landed yet. */
  const persistIdentityConsent = useCallback(async () => {
    if (identityConsentPersisted || !user?.id) return true;
    setIdentityConsentPersisted(true);
    const { error } = await upsertOnboardingData(user.id, {
      identity_consent_at: new Date().toISOString(),
      consent_version: CONSENT_VERSION,
    });
    if (error) {
      setIdentityConsentPersisted(false);
      toast({
        title: 'Error',
        description: error.message || 'Unable to save consent. Please try again.',
        status: 'error',
        duration: 5000,
      });
      return false;
    }
    return true;
  }, [identityConsentPersisted, user, toast]);

  const handleIdentityConsentChange = useCallback((checked: boolean) => {
    setIdentityConsentChecked(checked);
    if (checked) setIdentityConsentError(false);
  }, []);

  const startVerification = async () => {
    // Legal gate: the user must consent before a Stripe Identity session exists.
    if (!identityConsentChecked) {
      setIdentityConsentError(true);
      return;
    }
    setStartingVerification(true);

    // Persist the consent BEFORE creating the verification session (audit order:
    // never a Stripe session without a recorded consent).
    const consentSaved = await persistIdentityConsent();
    if (!consentSaved) {
      setStartingVerification(false);
      return;
    }

    try {
      if (!session?.access_token) {
        throw new Error('Not authenticated');
      }

      // Build phone number with country code
      const fullPhone = onboardingData?.phone_country_code && onboardingData?.phone_number
        ? `${onboardingData.phone_country_code}${onboardingData.phone_number}`
        : undefined;

      // Call edge function to create verification session
      const response = await fetch(
        `${config.GCP_API_BASE_URL}/functions/v1/create-verification-session`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            email: onboardingData?.email,
            phone: fullPhone,
            returnUrl: `${window.location.origin}/onboarding/verify-complete`,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to start verification');
      }

      // Redirect to Stripe verification URL
      if (result.session?.url) {
        window.location.href = result.session.url;
      } else {
        throw new Error('No verification URL received');
      }
    } catch (error: any) {
      console.error('Verification error:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to start verification',
        status: 'error',
        duration: 5000,
      });
      setStartingVerification(false);
    }
  };

  /* Defer ("I'll do this later") — confirm first, then record an explicit,
     auditable deferred state instead of a silent navigate. */
  const openSkipConfirm = useCallback(() => setIsSkipConfirmOpen(true), []);
  const closeSkipConfirm = useCallback(() => {
    if (isSkipping) return;
    setIsSkipConfirmOpen(false);
  }, [isSkipping]);
  const handleConfirmSkip = useCallback(async () => {
    if (!user?.id) { navigate('/hushh-user-profile'); return; }
    setIsSkipping(true);
    try {
      await upsertOnboardingData(user.id, {
        identity_verification_deferred_at: new Date().toISOString(),
      });
      setIsSkipConfirmOpen(false);
      navigate('/hushh-user-profile');
    } catch {
      navigate('/hushh-user-profile');
    } finally {
      setIsSkipping(false);
    }
  }, [user, navigate]);

  const goBack = () => navigate('/hushh-user-profile');

  const startDisabled = startingVerification || !identityConsentChecked;

  return {
    loading,
    startingVerification,
    startDisabled,
    onboardingData,
    verificationStatus,
    // consent
    identityConsentChecked,
    identityConsentError,
    handleIdentityConsentChange,
    // actions
    startVerification,
    // defer
    isSkipConfirmOpen,
    isSkipping,
    openSkipConfirm,
    closeSkipConfirm,
    handleConfirmSkip,
    goBack,
  };
}
