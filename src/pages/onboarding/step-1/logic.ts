/**
 * Step 1 — Referral Source
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import config from '../../../resources/config/config';
import { upsertOnboardingData } from '../../../services/onboarding/upsertOnboardingData';
import { trackCta, trackStepCompleted } from '../../../services/onboarding/onboardingAnalytics';
import {
  FINANCIAL_LINK_REVIEW_ROUTE,
  TOTAL_VISIBLE_ONBOARDING_STEPS,
  isCurrentLocalOnboardingPreview,
  withLocalOnboardingPreview,
} from '../../../services/onboarding/flow';
import type { ReferralSource } from '../../../types/onboarding';

export const CURRENT_STEP = 1;
export const TOTAL_STEPS = TOTAL_VISIBLE_ONBOARDING_STEPS;
export const PROGRESS_PCT = Math.round((CURRENT_STEP / TOTAL_STEPS) * 100);

export type ReferralChoice =
  | 'social_media_ad'
  | 'family_friend'
  | 'podcast'
  | 'website_blog_article'
  | 'ai_tool'
  | 'other';

export interface ReferralOption {
  value: ReferralChoice;
  label: string;
  icon: string;
}

export const REFERRAL_OPTIONS: ReferralOption[] = [
  { value: 'social_media_ad', label: 'Social Media', icon: 'campaign' },
  { value: 'family_friend', label: 'Friend or Family', icon: 'group' },
  { value: 'podcast', label: 'Podcast', icon: 'mic' },
  { value: 'website_blog_article', label: 'Publication', icon: 'newspaper' },
  { value: 'ai_tool', label: 'Google Search', icon: 'search' },
  { value: 'other', label: 'Other', icon: 'more_horiz' },
];

export const SOCIAL_MEDIA_OPTIONS = [
  'LinkedIn',
  'X',
  'Instagram',
  'Facebook',
  'YouTube',
  'Reddit',
  'TikTok',
  'Threads',
];

export const PUBLICATION_OPTIONS = [
  'The New York Times',
  'The Wall Street Journal',
  'The Washington Post',
  'USA Today',
  'Los Angeles Times',
  'New York Post',
  'Chicago Tribune',
  'Bloomberg',
  'Forbes',
  'CNBC',
];

const normalizeReferralChoice = (source: unknown): ReferralChoice | null => {
  if (!source) return null;
  const key = String(source).trim().toLowerCase();
  if (key.includes('social')) return 'social_media_ad';
  if (key.includes('publication') || key.includes('news') || key === 'website_blog_article') {
    return 'website_blog_article';
  }
  if (key.includes('friend') || key.includes('family')) return 'family_friend';
  if (key.includes('podcast')) return 'podcast';
  if (key.includes('google') || key.includes('search') || key === 'ai_tool') return 'ai_tool';
  if (key.includes('other')) return 'other';
  return null;
};

export interface Step1Logic {
  selectedSource: ReferralChoice | null;
  detailValue: string;
  detailQuery: string;
  filteredDetailOptions: string[];
  isDetailRequired: boolean;
  isLoading: boolean;
  canContinue: boolean;
  setSelectedSource: (source: ReferralChoice) => void;
  setDetailQuery: (value: string) => void;
  selectDetail: (value: string) => void;
  handleContinue: () => Promise<void>;
  handleBack: () => void;
}

const getDetailOptions = (source: ReferralChoice | null) => {
  const key = source ? String(source) : '';
  if (key.includes('social')) return SOCIAL_MEDIA_OPTIONS;
  if (key.includes('website_blog_article') || key.includes('publication') || key.includes('news')) {
    return PUBLICATION_OPTIONS;
  }
  return [];
};

export const useStep1Logic = (): Step1Logic => {
  const navigate = useNavigate();
  const isPreview = isCurrentLocalOnboardingPreview();
  const [userId, setUserId] = useState<string | null>(null);
  const [selectedSource, setSelectedSourceState] = useState<ReferralChoice | null>(null);
  const [detailValue, setDetailValue] = useState('');
  const [detailQuery, setDetailQueryState] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => { window.scrollTo(0, 0); }, []);

  useEffect(() => {
    const load = async () => {
      if (isPreview) {
        setUserId('local-preview');
        setSelectedSourceState(null);
        setDetailValue('');
        setDetailQueryState('');
        return;
      }

      if (!config.gcpBackendClient) return;
      const { data: { user } } = await config.gcpBackendClient.auth.getUser();
      if (!user) { navigate('/login'); return; }
      setUserId(user.id);
      const { data } = await config.gcpBackendClient
        .from('onboarding_data')
        .select('referral_source, referral_source_other')
        .eq('user_id', user.id)
        .maybeSingle();
      const normalizedSource = normalizeReferralChoice(data?.referral_source);
      if (normalizedSource) setSelectedSourceState(normalizedSource);
      if (data?.referral_source_other) setDetailValue(String(data.referral_source_other));
    };
    load();
  }, [isPreview, navigate]);

  const detailOptions = getDetailOptions(selectedSource);
  const isDetailRequired = selectedSource === 'social_media_ad' ||
    selectedSource === 'website_blog_article' ||
    selectedSource === 'other';
  const filteredDetailOptions = useMemo(() => {
    const query = detailQuery.trim().toLowerCase();
    if (!query) return detailOptions;
    return detailOptions.filter((option) => option.toLowerCase().includes(query));
  }, [detailOptions, detailQuery]);

  const setSelectedSource = (source: ReferralChoice) => {
    if (selectedSource === source) return;
    setSelectedSourceState(source);
    setDetailValue('');
    setDetailQueryState('');
  };

  const setDetailQuery = (value: string) => {
    setDetailQueryState(value);
  };

  const selectDetail = (value: string) => {
    setDetailValue(value);
    setDetailQueryState(value);
  };

  const effectiveDetailValue = detailValue.trim() || detailQuery.trim();
  const canContinue = Boolean(selectedSource && (!isDetailRequired || effectiveDetailValue));

  const savePreview = () => {
    const saved = window.localStorage.getItem('hushh_onboarding_preview');
    const parsed = saved ? JSON.parse(saved) : {};
    window.localStorage.setItem('hushh_onboarding_preview', JSON.stringify({
      ...parsed,
      referral_source: selectedSource,
      referral_source_other: effectiveDetailValue || null,
    }));
  };

  const handleContinue = async () => {
    trackCta('continue', 'step-1');
    if (!canContinue) return;
    if (isPreview) {
      savePreview();
      navigate(withLocalOnboardingPreview('/onboarding/step-2'));
      return;
    }
    if (!userId || !config.gcpBackendClient || !selectedSource) return;
    setIsLoading(true);
    try {
      await upsertOnboardingData(userId, {
        referral_source: selectedSource as ReferralSource,
        referral_source_other: effectiveDetailValue || null,
        current_step: 2,
      });
      trackStepCompleted('step-1', 1);
      navigate('/onboarding/step-2');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBack = () => {
    if (isPreview) {
      navigate(withLocalOnboardingPreview(FINANCIAL_LINK_REVIEW_ROUTE));
      return;
    }
    navigate(FINANCIAL_LINK_REVIEW_ROUTE);
  };

  return {
    selectedSource,
    detailValue,
    detailQuery,
    filteredDetailOptions,
    isDetailRequired,
    isLoading,
    canContinue,
    setSelectedSource,
    setDetailQuery,
    selectDetail,
    handleContinue,
    handleBack,
  };
};
