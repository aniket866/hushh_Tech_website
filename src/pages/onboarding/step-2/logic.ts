/**
 * Step 2 — Account Type
 */
import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import config from '../../../resources/config/config';
import { upsertOnboardingData } from '../../../services/onboarding/upsertOnboardingData';
import { trackCta, trackStepCompleted } from '../../../services/onboarding/onboardingAnalytics';
import {
  TOTAL_VISIBLE_ONBOARDING_STEPS,
  REVIEW_ROUTE,
  isCurrentLocalOnboardingPreview,
  isReturnToReview,
  withLocalOnboardingPreview,
} from '../../../services/onboarding/flow';
import type { UIAccountType } from '../../../types/onboarding';
import {
  ACCOUNT_TYPE_OPTIONS,
  accountStructureFor,
  isAccountTypeAvailable,
  type AccountTypeOption,
} from '../../../services/onboarding/accountTypeConfig';

export const CURRENT_STEP = 2;
export const TOTAL_STEPS = TOTAL_VISIBLE_ONBOARDING_STEPS;
export const PROGRESS_PCT = Math.round((CURRENT_STEP / TOTAL_STEPS) * 100);

// Account-type options + AccountTypeOption now come from the single source of
// truth (accountTypeConfig). Re-exported so step-2/ui's `import { ... } from './logic'`
// keeps working.
export { ACCOUNT_TYPE_OPTIONS };
export type { AccountTypeOption };

export interface Step2Logic {
  selectedAccountType: UIAccountType | null;
  isLoading: boolean;
  returnToReview: boolean;
  setSelectedAccountType: (value: UIAccountType) => void;
  handleContinue: () => Promise<void>;
  /** Persist the picked account type (no current_step bump) before entering the sub-steps. */
  persistAccountType: () => Promise<boolean>;
  handleBack: () => void;
}

export const useStep2Logic = (): Step2Logic => {
  const navigate = useNavigate();
  const location = useLocation();
  // When opened from Review (`?from=review`), Save/Back return to Review instead
  // of marching forward, and the save must not downgrade `current_step`.
  const returnToReview = isReturnToReview(location.search);
  const isPreview = isCurrentLocalOnboardingPreview();
  const [userId, setUserId] = useState<string | null>(null);
  const [selectedAccountType, setSelectedAccountType] = useState<UIAccountType | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => { window.scrollTo(0, 0); }, []);

  useEffect(() => {
    const load = async () => {
      if (isPreview) {
        setUserId('local-preview');
        setSelectedAccountType(null);
        return;
      }
      if (!config.gcpBackendClient) return;
      const { data: { user } } = await config.gcpBackendClient.auth.getUser();
      if (!user) { navigate('/login'); return; }
      setUserId(user.id);
      const { data } = await config.gcpBackendClient
        .from('onboarding_data')
        .select('account_type, account_structure')
        .eq('user_id', user.id)
        .maybeSingle();
      const validTypes: UIAccountType[] = ['individual', 'joint', 'retirement', 'trust'];
      // Only restore a previously-saved type if it is still selectable. Types
      // under development (Joint/Retirement/Trust) are not restored, so a stale
      // selection can't pre-enable Continue while the option is disabled.
      if (
        data?.account_type &&
        validTypes.includes(data.account_type as UIAccountType) &&
        isAccountTypeAvailable(data.account_type as UIAccountType)
      ) {
        setSelectedAccountType(data.account_type as UIAccountType);
      }
    };
    load();
  }, [isPreview, navigate]);

  const savePreview = () => {
    const saved = window.localStorage.getItem('hushh_onboarding_preview');
    const parsed = saved ? JSON.parse(saved) : {};
    window.localStorage.setItem('hushh_onboarding_preview', JSON.stringify({
      ...parsed,
      account_type: selectedAccountType,
      account_structure: selectedAccountType ? accountStructureFor(selectedAccountType) : null,
    }));
  };

  const nextRoute = returnToReview ? REVIEW_ROUTE : '/onboarding/step-3';

  const handleContinue = async () => {
    trackCta('continue', 'step-2');
    if (!selectedAccountType) return;
    if (isPreview) {
      savePreview();
      navigate(withLocalOnboardingPreview(nextRoute));
      return;
    }
    if (!userId || !config.gcpBackendClient) return;
    setIsLoading(true);
    try {
      await upsertOnboardingData(userId, {
        account_type: selectedAccountType,
        account_structure: accountStructureFor(selectedAccountType),
        // Editing from Review: leave current_step untouched so the
        // ProtectedRoute skip-guard doesn't bounce the return to Review.
        ...(returnToReview ? {} : { current_step: 3 }),
      });
      trackStepCompleted('step-2', 2);
      navigate(withLocalOnboardingPreview(nextRoute));
    } finally {
      setIsLoading(false);
    }
  };

  const persistAccountType = async (): Promise<boolean> => {
    if (!selectedAccountType) return false;
    if (isPreview) {
      savePreview();
      return true;
    }
    if (!userId || !config.gcpBackendClient) return false;
    const { error } = await upsertOnboardingData(userId, {
      account_type: selectedAccountType,
      account_structure: accountStructureFor(selectedAccountType),
    });
    return !error;
  };

  const handleBack = () =>
    navigate(withLocalOnboardingPreview(returnToReview ? REVIEW_ROUTE : '/onboarding/step-1'));

  return {
    selectedAccountType,
    isLoading,
    returnToReview,
    setSelectedAccountType,
    handleContinue,
    persistAccountType,
    handleBack,
  };
};
