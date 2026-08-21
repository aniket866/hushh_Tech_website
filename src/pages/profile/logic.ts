/**
 * Profile Page — Logic / ViewModel
 * Session, onboarding status, NDA check (once, no polling).
 * UI stays in ui.tsx.
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import config from '../../resources/config/config';
import { useAuthSession } from '../../auth/AuthSessionProvider';
import { checkAccessStatus } from '../../services/access/accessControlApi';
import { fetchResolvedOnboardingProgress } from '../../services/onboarding/progress';
import { useInvestorJourneyCta } from '../../hooks/useInvestorJourneyCta';
import {
  getHushhResearchCompatibilityMode,
  hasHushhResearchProfileMetadata,
  readHushhResearchCompatibilityIfActive,
} from '../../services/hushhResearch/compatibility';
import { HUSHH_RESEARCH_SOURCE } from '../../services/hushhResearch/contracts';
import { isHushhResearchAuthMode } from '../../services/hushhResearch/firebaseAuth';

export async function fetchCompatibleProfileBuiltStatus(
  client: SupabaseClient | undefined,
  userId: string,
  researchBoundary = false,
): Promise<boolean> {
  const researchProfile = await readHushhResearchCompatibilityIfActive(
    'profile',
    { researchBoundary },
  );
  if (researchProfile.mode === 'research') {
    return hasHushhResearchProfileMetadata(researchProfile.response.payload);
  }
  if (!client) {
    throw new Error('Supabase client is unavailable outside Research mode.');
  }

  const { data: profile, error } = await client
    .from('investor_profiles')
    .select('id, user_confirmed')
    .eq('user_id', userId)
    .maybeSingle();

  return Boolean(profile) && !error;
}

export async function isCompatibleNdaApproved(
  accessToken: string,
  readAccessStatus: (token: string) => Promise<unknown> = checkAccessStatus,
  researchBoundary = false,
): Promise<boolean> {
  // Research access-state metadata must never be treated as NDA proof. A
  // Research session remains denied without touching the legacy NDA backend.
  if (
    researchBoundary ||
    (await getHushhResearchCompatibilityMode({ researchBoundary })) ===
      'research'
  ) {
    return false;
  }

  return (await readAccessStatus(accessToken)) === 'Approved';
}

export function useProfileLogic() {
  const navigate = useNavigate();
  const { session } = useAuthSession();
  const isResearchSession =
    isHushhResearchAuthMode() ||
    session?.user?.app_metadata?.auth_source === HUSHH_RESEARCH_SOURCE;
  const [ndaApproved, setNdaApproved] = useState(false);
  const ndaCheckedRef = useRef(false);

  // CTA is delegated to the shared journey hook so this page no longer
  // re-implements the "where should this user go next" state machine.
  const { primaryCTA } = useInvestorJourneyCta();

  /* onboarding status — read once to feed the page's other UI affordances
     (e.g., shimmer state, completion badges). The CTA itself comes from
     the journey hook above and is no longer derived locally. */
  const [onboardingStatus, setOnboardingStatus] = useState<{
    hasProfile: boolean;
    isCompleted: boolean;
    currentStep: number;
    financialLinkStatus: 'pending' | 'completed' | 'skipped';
    loading: boolean;
  }>({
    hasProfile: false,
    isCompleted: false,
    currentStep: 1,
    financialLinkStatus: 'pending',
    loading: true,
  });

  useEffect(() => {
    if (
      !session?.user?.id ||
      (!config.supabaseClient && !isResearchSession)
    ) {
      const timeoutId = window.setTimeout(() => {
        setOnboardingStatus((prev) => ({ ...prev, loading: false }));
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }

    const checkUserStatus = async () => {
      try {
        const [hasProfile, onboarding] = await Promise.all([
          fetchCompatibleProfileBuiltStatus(
            config.supabaseClient,
            session.user.id,
            isResearchSession,
          ),
          fetchResolvedOnboardingProgress(
            config.supabaseClient,
            session.user.id,
            { researchBoundary: isResearchSession },
          ),
        ]);

        setOnboardingStatus({
          hasProfile,
          isCompleted: onboarding?.is_completed || false,
          currentStep: onboarding?.current_step || 1,
          financialLinkStatus: onboarding?.financial_link_status || 'pending',
          loading: false,
        });
      } catch (error) {
        console.error('Error checking user status:', error);
        setOnboardingStatus((prev) => ({ ...prev, loading: false }));
      }
    };

    checkUserStatus();
  }, [isResearchSession, session?.user?.id]);

  /* check NDA status ONCE (no polling) */
  useEffect(() => {
    if (!session?.access_token || ndaCheckedRef.current) return;
    ndaCheckedRef.current = true;

    const checkNda = async () => {
      try {
        if (
          await isCompatibleNdaApproved(
            session.access_token,
            checkAccessStatus,
            isResearchSession,
          )
        ) {
          setNdaApproved(true);
        }
      } catch (err: unknown) {
        const failure = err as {
          response?: { status?: number };
          message?: string;
        };
        /* 401 = expired/invalid token — silently ignore, don't retry */
        if (failure.response?.status === 401) return;
        console.warn('NDA check failed:', failure.message);
      }
    };

    checkNda();
  }, [isResearchSession, session?.access_token]);

  const handleDiscoverFundA = () => navigate('/discover-fund-a');

  return {
    session,
    ndaApproved,
    onboardingStatus,
    primaryCTA,
    handleDiscoverFundA,
  };
}
