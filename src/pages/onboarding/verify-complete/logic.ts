import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import config from '../../../resources/config/config';
import { upsertOnboardingData } from '../../../services/onboarding/upsertOnboardingData';

export type VerificationResult = 'verified' | 'processing' | 'requires_input' | 'failed' | 'loading';

export function useVerifyCompleteLogic() {
  const navigate = useNavigate();
  const [result, setResult] = useState<VerificationResult>('loading');
  const [pollingCount, setPollingCount] = useState(0);
  const [checks, setChecks] = useState({ document: false, selfie: false, email: false, phone: false });

  useEffect(() => {
    window.scrollTo(0, 0);
    checkVerificationStatus();
  }, []);

  useEffect(() => {
    if (result === 'processing' && pollingCount < 10) {
      const timer = setTimeout(() => {
        checkVerificationStatus();
        setPollingCount((prev) => prev + 1);
      }, 3000);

      return () => clearTimeout(timer);
    }
  }, [result, pollingCount]);

  const checkVerificationStatus = async () => {
    if (!config.gcpBackendClient) {
      return;
    }

    try {
      const {
        data: { user },
      } = await config.gcpBackendClient.auth.getUser();

      if (!user) {
        navigate('/login');
        return;
      }

      const { data: verification } = await config.gcpBackendClient
        .from('identity_verifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (verification) {
        setChecks({
          document: Boolean(verification.document_verified),
          selfie: Boolean(verification.selfie_verified),
          email: Boolean(verification.email_verified),
          phone: Boolean(verification.phone_verified),
        });
        switch (verification.stripe_status) {
          case 'verified':
            setResult('verified');
            await upsertOnboardingData(user.id, {
              identity_verified: true,
              identity_verified_at: new Date().toISOString(),
            });
            break;
          case 'processing':
          case 'pending':
            setResult('processing');
            break;
          case 'requires_input':
            setResult('requires_input');
            break;
          case 'failed':
          case 'canceled':
            setResult('failed');
            break;
          default:
            setResult('processing');
        }
      } else {
        setResult('processing');
      }
    } catch (error) {
      console.error('Error checking status:', error);
      setResult('processing');
    }
  };

  const handleContinue = () => {
    navigate('/hushh-user-profile');
  };

  const handleRetry = () => {
    navigate('/onboarding/verify');
  };

  return {
    result,
    pollingCount,
    checks,
    handleContinue,
    handleRetry,
  };
}
