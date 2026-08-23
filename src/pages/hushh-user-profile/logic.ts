/**
 * HushhUserProfile — All Business Logic
 * State, effects, handlers, constants extracted into useHushhUserProfileLogic hook
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast, useClipboard } from '@chakra-ui/react';
import { useFooterVisibility } from '../../utils/useFooterVisibility';
import resources from '../../resources/resources';
import { generateInvestorProfile } from '../../services/investorProfile/apiClient';
import { generateProfileIntelligence } from '../../services/profileIntelligence/apiClient';
import {
  APPLE_WALLET_SUPPORT_MESSAGE,
  buildGoldPassPreviewModel,
  downloadHushhGoldPass,
  fetchGoogleWalletAvailability,
  GOOGLE_WALLET_SUPPORT_MESSAGE,
  isAppleWalletSupported,
  launchGoogleWalletPass,
} from '../../services/walletPass';
import { InvestorProfile, FIELD_LABELS, VALUE_LABELS } from '../../types/investorProfile';
import type { ShadowProfile } from '../../types/shadowProfile';
import { calculateNWSFromDB, NWSResult } from '../../services/networkScore/calculateNWS';
import { useAuthSession } from '../../auth/AuthSessionProvider';
import { buildLoginRedirectPath } from '../../auth/routePolicy';

// Re-export types for UI
export type { InvestorProfile, NWSResult };
export { FIELD_LABELS, VALUE_LABELS };

// Complete country list matching Step 6 onboarding - using full country names
const COUNTRIES = [
  'United States',
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Argentina', 'Armenia', 'Australia',
  'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus', 'Belgium',
  'Belize', 'Benin', 'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei',
  'Bulgaria', 'Burkina Faso', 'Burundi', 'Cambodia', 'Cameroon', 'Canada', 'Cape Verde',
  'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros', 'Congo',
  'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czech Republic', 'Denmark', 'Djibouti', 'Dominica',
  'Dominican Republic', 'East Timor', 'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea',
  'Eritrea', 'Estonia', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia',
  'Germany', 'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana',
  'Haiti', 'Honduras', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland',
  'Israel', 'Italy', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'North Korea',
  'South Korea', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia',
  'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Macedonia', 'Madagascar', 'Malawi',
  'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico',
  'Micronesia', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar',
  'Namibia', 'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria',
  'Norway', 'Oman', 'Pakistan', 'Palau', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru',
  'Philippines', 'Poland', 'Portugal', 'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saint Kitts and Nevis',
  'Saint Lucia', 'Saint Vincent and the Grenadines', 'Samoa', 'San Marino', 'Sao Tome and Principe',
  'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore', 'Slovakia',
  'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa', 'South Sudan', 'Spain', 'Sri Lanka',
  'Sudan', 'Suriname', 'Swaziland', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan',
  'Tanzania', 'Thailand', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey', 'Turkmenistan',
  'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'Uruguay',
  'Uzbekistan', 'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe'
];

interface FormState {
  name: string;
  email: string;
  age: number | "";
  phoneCountryCode: string;
  phoneNumber: string;
  organisation: string;
  // Onboarding fields
  accountType: string;
  selectedFund: string;
  referralSource: string;
  citizenshipCountry: string;
  residenceCountry: string;
  accountStructure: string;
  legalFirstName: string;
  legalLastName: string;
  addressLine1: string;
  city: string;
  state: string;
  zipCode: string;
  dateOfBirth: string;
  initialInvestmentAmount: number | "";
}

const defaultFormState: FormState = {
  name: "",
  email: "",
  age: "",
  phoneCountryCode: "+1",
  phoneNumber: "",
  organisation: "",
  accountType: "",
  selectedFund: "",
  referralSource: "",
  citizenshipCountry: "",
  residenceCountry: "",
  accountStructure: "",
  legalFirstName: "",
  legalLastName: "",
  addressLine1: "",
  city: "",
  state: "",
  zipCode: "",
  dateOfBirth: "",
  initialInvestmentAmount: "",
};

export type { FormState };
export { defaultFormState };

export const useHushhUserProfileLogic = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const isFooterVisible = useFooterVisibility();
  const { session, status, user } = useAuthSession();
  const [form, setForm] = useState<FormState>(defaultFormState);
  const [userId, setUserId] = useState<string | null>(null);
  const [investorProfile, setInvestorProfile] = useState<InvestorProfile | null>(null);
  const [shadowProfile, setShadowProfile] = useState<ShadowProfile | null>(null);
  const [profileSlug, setProfileSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-API status for non-blocking background processing
  type ApiStatus = 'idle' | 'running' | 'done' | 'error' | 'skipped';
  const [investorStatus, setInvestorStatus] = useState<ApiStatus>('idle');
  const [intelligenceStatus, setIntelligenceStatus] = useState<ApiStatus>('idle');
  const isProcessing = investorStatus === 'running' || intelligenceStatus === 'running';
  const [hasOnboardingData, setHasOnboardingData] = useState(false);
  const [isApplePassLoading, setIsApplePassLoading] = useState(false);
  const [isGooglePassLoading, setIsGooglePassLoading] = useState(false);
  const [isWalletPreviewOpen, setIsWalletPreviewOpen] = useState(false);
  const [googleWalletSupported, setGoogleWalletSupported] = useState(false);
  const [googleWalletSupportMessage, setGoogleWalletSupportMessage] = useState(
    GOOGLE_WALLET_SUPPORT_MESSAGE
  );
  const [editingField, setEditingField] = useState<string | null>(null);
  // Dirty tracking — true when user manually edits any form field
  const [isDirty, setIsDirty] = useState(false);
  // Dirty tracking for AI profile field edits (separate from form edits)
  const [isAiProfileDirty, setIsAiProfileDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const appleWalletSupported = isAppleWalletSupported();
  // NWS Score state
  const [nwsResult, setNwsResult] = useState<NWSResult | null>(null);
  const [nwsLoading, setNwsLoading] = useState(true);

  // Elapsed timer — shows seconds while AI generates (UX feedback)
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    setLoadingSeconds(0);
    timerRef.current = setInterval(() => setLoadingSeconds((s) => s + 1), 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setLoadingSeconds(0);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isProcessing) {
      if (timerRef.current) {
        stopTimer();
      }
      if (loading) {
        setLoading(false);
      }
    }
  }, [isProcessing, loading, stopTimer]);

  useEffect(() => {
    let active = true;

    fetchGoogleWalletAvailability().then((availability) => {
      if (!active) return;
      setGoogleWalletSupported(availability.available);
      setGoogleWalletSupportMessage(availability.message);
    });

    return () => {
      active = false;
    };
  }, []);

  // Field options for AI-generated profile editing
  const FIELD_OPTIONS: Record<string, { value: string; label: string }[]> = {
    primary_goal: [
      { value: "capital_preservation", label: "Capital Preservation" },
      { value: "steady_income", label: "Steady Income" },
      { value: "long_term_growth", label: "Long-term Growth" },
      { value: "aggressive_growth", label: "Aggressive Growth" },
      { value: "speculation", label: "Speculation" },
    ],
    investment_horizon_years: [
      { value: "<3_years", label: "Less than 3 years" },
      { value: "3_5_years", label: "3-5 years" },
      { value: "5_10_years", label: "5-10 years" },
      { value: ">10_years", label: "More than 10 years" },
    ],
    risk_tolerance: [
      { value: "very_low", label: "Very Low" },
      { value: "low", label: "Low" },
      { value: "moderate", label: "Moderate" },
      { value: "high", label: "High" },
      { value: "very_high", label: "Very High" },
    ],
    liquidity_need: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    experience_level: [
      { value: "beginner", label: "Beginner" },
      { value: "intermediate", label: "Intermediate" },
      { value: "advanced", label: "Advanced" },
    ],
    typical_ticket_size: [
      { value: "micro_<1m", label: "Micro (< $1 million)" },
      { value: "small_1m_10m", label: "Small ($1M - $10M)" },
      { value: "medium_10m_50m", label: "Medium ($10M - $50M)" },
      { value: "large_>50m", label: "Large (> $50 million)" },
    ],
    annual_investing_capacity: [
      { value: "<5m", label: "< $5 million" },
      { value: "5m_20m", label: "$5M - $20M" },
      { value: "20m_100m", label: "$20M - $100M" },
      { value: ">100m", label: "> $100 million" },
    ],
    asset_class_preference: [
      { value: "public_equities", label: "Public Equities" },
      { value: "mutual_funds_etfs", label: "Mutual Funds / ETFs" },
      { value: "fixed_income", label: "Fixed Income" },
      { value: "real_estate", label: "Real Estate" },
      { value: "startups_private_equity", label: "Startups / Private Equity" },
      { value: "crypto_digital_assets", label: "Crypto / Digital Assets" },
      { value: "cash_equivalents", label: "Cash Equivalents" },
    ],
    sector_preferences: [
      { value: "technology", label: "Technology" },
      { value: "consumer_internet", label: "Consumer Internet" },
      { value: "fintech", label: "Fintech" },
      { value: "healthcare", label: "Healthcare" },
      { value: "real_estate", label: "Real Estate" },
      { value: "energy_climate", label: "Energy & Climate" },
      { value: "industrial", label: "Industrial" },
      { value: "other", label: "Other" },
    ],
    volatility_reaction: [
      { value: "sell_to_avoid_more_loss", label: "Sell to Avoid More Loss" },
      { value: "hold_and_wait", label: "Hold and Wait" },
      { value: "buy_more_at_lower_prices", label: "Buy More at Lower Prices" },
    ],
    sustainability_preference: [
      { value: "not_important", label: "Not Important" },
      { value: "nice_to_have", label: "Nice to Have" },
      { value: "important", label: "Important" },
      { value: "very_important", label: "Very Important" },
    ],
    engagement_style: [
      { value: "very_passive_just_updates", label: "Very Passive (Just Updates)" },
      { value: "collaborative_discuss_key_decisions", label: "Collaborative (Discuss Key Decisions)" },
      { value: "hands_on_active_trader", label: "Hands-on (Active Trader)" },
    ],
  };

  // Multi-select fields
  const MULTI_SELECT_FIELDS = ["asset_class_preference", "sector_preferences"];

  // Handle updating an AI profile field
  const handleUpdateAIField = (fieldName: string, newValue: string | string[]) => {
    if (!investorProfile) return;
    
    setInvestorProfile({
      ...investorProfile,
      [fieldName]: {
        ...investorProfile[fieldName as keyof InvestorProfile],
        value: newValue,
      },
    });
    setEditingField(null);
    // Mark AI profile as dirty so Save Changes can persist it
    setIsAiProfileDirty(true);
    setIsDirty(true);
  };

  // Handle multi-select toggle
  const handleMultiSelectToggle = (fieldName: string, optionValue: string) => {
    if (!investorProfile) return;
    
    const fieldData = investorProfile[fieldName as keyof InvestorProfile];
    const currentValues = fieldData?.value || [];
    const currentArray: string[] = Array.isArray(currentValues) 
      ? (currentValues as string[]) 
      : [currentValues as string];
    
    let newValues: string[];
    if (currentArray.includes(optionValue)) {
      newValues = currentArray.filter((v) => v !== optionValue);
    } else {
      newValues = [...currentArray, optionValue];
    }
    
    setInvestorProfile({
      ...investorProfile,
      [fieldName]: {
        ...investorProfile[fieldName as keyof InvestorProfile],
        value: newValues,
      },
    });
    // Mark AI profile as dirty so Save Changes can persist it
    setIsAiProfileDirty(true);
    setIsDirty(true);
  };

  // Profile URL for sharing
  const profileUrl = profileSlug ? `https://hushhtech.com/investor/${profileSlug}` : "";
  const { hasCopied, onCopy } = useClipboard(profileUrl);

  // Scroll to top on mount
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // Check authentication on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const gcpBackend = resources.config.gcpBackendClient;
        if (!gcpBackend) {
          setNwsLoading(false);
          return;
        }

        if (status === 'booting') {
          return;
        }

        if (status !== 'authenticated' || !user) {
          navigate(buildLoginRedirectPath('/hushh-user-profile'), { replace: true });
          setNwsLoading(false);
          return;
        }

        setUserId(user.id);

        // Prefill form with user metadata
        const fullName =
          (user.user_metadata?.full_name as string) ||
          [user.user_metadata?.first_name, user.user_metadata?.last_name]
            .filter(Boolean)
            .join(" ") ||
          "";

        setForm((prev) => ({
          ...prev,
          name: fullName || prev.name,
          email: user.email || prev.email,
          organisation: (user.user_metadata?.company as string) || prev.organisation,
        }));

        // Load existing investor profile
        const { data: existingProfile } = await gcpBackend
          .from("investor_profiles")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        if (existingProfile) {
          // Always load the slug if it exists (regardless of investor_profile)
          if (existingProfile.slug) {
            setProfileSlug(existingProfile.slug);
          }
          
          // Load AI-generated profile if available
          if (existingProfile.investor_profile) {
            setInvestorProfile(existingProfile.investor_profile);
            setInvestorStatus('done');
          }

          if (existingProfile.shadow_profile) {
            const existingShadowProfile = existingProfile.shadow_profile as ShadowProfile;
            setShadowProfile(existingShadowProfile);
            if (existingShadowProfile.profileIntelligence) {
              setIntelligenceStatus('done');
            }
          }
          
          // Prefill form from investor_profiles table
          setForm((prev) => ({
            ...prev,
            name: existingProfile.name || fullName,
            email: existingProfile.email || user.email || "",
            age: existingProfile.age || "",
            phoneCountryCode: existingProfile.phone_country_code || "+1",
            phoneNumber: existingProfile.phone_number || "",
            organisation: existingProfile.organisation || "",
          }));
        }

        // Load onboarding data
        const { data: onboardingData } = await gcpBackend
          .from("onboarding_data")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        if (onboardingData) {
          // Mark that user has completed onboarding
          setHasOnboardingData(true);
          
          const calculatedAge = onboardingData.date_of_birth
            ? new Date().getFullYear() - new Date(onboardingData.date_of_birth).getFullYear()
            : "";

          // Build name from onboarding data
          const onboardingName = onboardingData.legal_first_name && onboardingData.legal_last_name
            ? `${onboardingData.legal_first_name} ${onboardingData.legal_last_name}`
            : fullName;

          setForm((prev) => ({
            ...prev,
            name: onboardingName || prev.name,
            age: calculatedAge || prev.age,
            // Pre-fill phone number from onboarding (Step 8)
            phoneCountryCode: onboardingData.phone_country_code || prev.phoneCountryCode,
            phoneNumber: onboardingData.phone_number || prev.phoneNumber,
            accountType: onboardingData.account_type || "",
            selectedFund: onboardingData.selected_fund || "",
            referralSource: onboardingData.referral_source || "",
            citizenshipCountry: onboardingData.citizenship_country || "",
            residenceCountry: onboardingData.residence_country || "",
            accountStructure: onboardingData.account_structure || "",
            legalFirstName: onboardingData.legal_first_name || "",
            legalLastName: onboardingData.legal_last_name || "",
            addressLine1: onboardingData.address_line_1 || "",
            city: onboardingData.city || "",
            state: onboardingData.state || "",
            zipCode: onboardingData.zip_code || "",
            dateOfBirth: onboardingData.date_of_birth || "",
            initialInvestmentAmount: onboardingData.initial_investment_amount || "",
          }));

          // Auto-create investor_profiles row if user completed onboarding but doesn't have one
          // This triggers the PostgreSQL slug generation trigger
          if (onboardingData.is_completed && !existingProfile) {
            const userName = onboardingName || user.email?.split('@')[0] || 'Investor';
            const userAge = typeof calculatedAge === 'number' ? calculatedAge : 30;
            
            const { data: newProfile } = await gcpBackend
              .from("investor_profiles")
              .upsert({
                user_id: user.id,
                name: userName,
                email: user.email || "",
                age: Math.max(18, Math.min(120, userAge)), // Clamp to DB constraint range
                phone_country_code: onboardingData.phone_country_code || "+1",
                phone_number: onboardingData.phone_number || "",
                organisation: null,
                investor_profile: null, // No AI profile yet, just basic row for slug
                is_public: true, // Public by default so shared links work
                user_confirmed: false,
              }, { onConflict: 'user_id' })
              .select("slug")
              .maybeSingle();

            // Set the slug immediately if created
            if (newProfile?.slug) {
              setProfileSlug(newProfile.slug);
            }
          }
        }
        // Load NWS score from user_financial_data (pure math, no API)
        try {
          const { data: financialData } = await gcpBackend
            .from('user_financial_data')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle();

          if (financialData) {
            const nws = calculateNWSFromDB(financialData);
            setNwsResult(nws);
            console.log('[Profile] NWS Score calculated:', nws.score, nws.grade);

            // Persist NWS score if not already saved
            if (!financialData.nws_score || financialData.nws_score !== nws.score) {
              gcpBackend.from('user_financial_data').update({
                nws_score: nws.score,
                nws_breakdown: nws.breakdown,
                nws_grade: nws.grade,
                nws_calculated_at: new Date().toISOString(),
              }).eq('user_id', user.id).then(() => {
                console.log('[Profile] NWS score persisted to DB');
              });

              // Send NWS score email notification (fire-and-forget)
              if (nws.score > 0 && session?.access_token) {
                fetch(`${resources.config.GCP_API_BASE_URL}/functions/v1/nws-score-notification`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                  body: JSON.stringify({
                    recipientEmail: user.email,
                    recipientName: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Investor',
                    nwsScore: nws.score,
                    nwsGrade: nws.grade,
                    nwsLabel: nws.label,
                    breakdown: nws.breakdown,
                  }),
                }).then(() => console.log('[Profile] NWS email sent')).catch(() => {});
              }
            }
          }
        } catch (nwsErr) {
          console.warn('[Profile] NWS calculation skipped:', nwsErr);
        } finally {
          setNwsLoading(false);
        }
      } catch (error) {
        console.error("Authentication check failed:", error);
        setNwsLoading(false);
      }
    };

    checkAuth();
  }, [navigate, session?.access_token, status, user]);

  const handleChange = (key: keyof FormState, value: string) => {
    if (key === "phoneNumber") {
      const digitsOnly = value.replace(/\D/g, '');
      if (digitsOnly.length > 15) return;
    }
    setForm((prev) => ({ ...prev, [key]: key === "age" || key === "initialInvestmentAmount" ? Number(value) || "" : value }));
    // Mark form as dirty when user edits any field
    setIsDirty(true);
  };

  const buildProfileIntelligenceContext = () => {
    const legalName = [form.legalFirstName, form.legalLastName]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" ");
    const country = form.residenceCountry || form.citizenshipCountry;

    return {
      ...(legalName ? { legalName } : {}),
      ...(form.organisation ? { organisation: form.organisation } : {}),
      ...(form.accountType ? { accountType: form.accountType } : {}),
      ...(form.selectedFund ? { selectedFund: form.selectedFund } : {}),
      ...(form.referralSource ? { referralSource: form.referralSource } : {}),
      ...(form.citizenshipCountry ? { citizenshipCountry: form.citizenshipCountry } : {}),
      ...(form.residenceCountry ? { residenceCountry: form.residenceCountry } : {}),
      ...(form.accountStructure ? { accountStructure: form.accountStructure } : {}),
      ...(form.city ? { city: form.city } : {}),
      ...(form.state ? { state: form.state } : {}),
      ...(country ? { country } : {}),
    };
  };

  // Helper: save partial profile data to GcpBackend (called by each API independently)
  const saveToSupabase = async (
    partialPayload: Record<string, unknown>
  ) => {
    if (!userId) return;
    const gcpBackend = resources.config.gcpBackendClient;
    if (!gcpBackend) return;
    try {
      const { data } = await gcpBackend
        .from("investor_profiles")
        .upsert({
          user_id: userId,
          name: form.name,
          email: form.email,
          age: typeof form.age === "number" ? form.age : Number(form.age),
          phone_country_code: form.phoneCountryCode,
          phone_number: form.phoneNumber,
          organisation: form.organisation || null,
          is_public: true,
          user_confirmed: true,
          confirmed_at: new Date().toISOString(),
          ...partialPayload,
        }, { onConflict: 'user_id' })
        .select("slug")
        .maybeSingle();
      if (data?.slug) setProfileSlug(data.slug);
    } catch (err) {
      console.warn("[Profile] GcpBackend save failed:", err);
    }
  };

  /**
   * handleSubmit — NON-BLOCKING background processing
   * Fires investor profile generation in the background.
   * User can scroll, edit, navigate while APIs run in background.
   * No timeout — this is a heavy API that takes as long as it needs.
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Prevent double-submit while already processing
    if (isProcessing || loading) return;

    // Validate required fields
    if (!form.name?.trim() || !form.email?.trim() || form.age === "") {
      toast({ title: "Missing fields", description: "Please fill in Name, Email, and Age", status: "warning", duration: 4000 });
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(form.email.trim())) {
      toast({ title: "Invalid email", description: "Please enter a valid email address", status: "warning", duration: 4000 });
      return;
    }

    const ageNum = typeof form.age === "number" ? form.age : Number(form.age);
    if (isNaN(ageNum) || ageNum < 18 || ageNum > 120) {
      toast({ title: "Invalid age", description: "Age must be between 18 and 120", status: "warning", duration: 4000 });
      return;
    }

    // ── Start background processing ──
    setLoading(true);
    setInvestorStatus('running');
    const zipCode = form.zipCode.trim();
    const hasIntelligenceZip = Boolean(zipCode);
    setIntelligenceStatus(hasIntelligenceZip ? 'running' : 'skipped');
    startTimer();

    toast({
      title: "Building your profile",
      description: "Hushh AI is analyzing in the background — you can keep scrolling",
      status: "info",
      duration: 5000,
      isClosable: true,
    });

    if (!hasIntelligenceZip) {
      toast({
        title: "Profile Intelligence skipped",
        description: "Add a ZIP code to research public profile signals. Investor profile generation will continue.",
        status: "warning",
        duration: 5000,
        isClosable: true,
      });
    }

    // ── API 1: Investor Profile (fire-and-forget) ──
    generateInvestorProfile({
      name: form.name,
      email: form.email,
      age: ageNum,
      phone_country_code: form.phoneCountryCode,
      phone_number: form.phoneNumber,
      organisation: form.organisation || undefined,
    }).then((result) => {
      if (result.success && result.profile) {
        setInvestorProfile(result.profile);
        setInvestorStatus('done');
        toast({ title: "Investor profile ready ✓", status: "success", duration: 3000 });
        // Save to GcpBackend (non-blocking)
        saveToSupabase({ investor_profile: result.profile });
      } else {
        setInvestorStatus('error');
        console.error("[Profile] Investor profile error:", result.error);
        toast({ title: "Investor profile failed", description: result.error || "Will retry later", status: "warning", duration: 4000 });
      }
    }).catch((err) => {
      setInvestorStatus('error');
      console.error("[Profile] Investor profile exception:", err);
      toast({ title: "Investor profile failed", description: "Network error — will retry later", status: "warning", duration: 4000 });
    });

    // ── API 2: Profile Intelligence (fire-and-forget; independent from investor profile) ──
    if (hasIntelligenceZip) {
      generateProfileIntelligence({
        name: form.name,
        email: form.email,
        zipCode,
        context: buildProfileIntelligenceContext(),
      }).then((result) => {
        if (result.success && result.shadowProfile) {
          setShadowProfile(result.shadowProfile);
          setIntelligenceStatus('done');
          toast({ title: "Profile intelligence ready ✓", status: "success", duration: 3000 });
          saveToSupabase({ shadow_profile: result.shadowProfile });
        } else if (result.skipped) {
          setIntelligenceStatus('skipped');
        } else {
          setIntelligenceStatus('error');
          console.error("[Profile] Profile intelligence error:", result.error);
          toast({
            title: "Profile intelligence failed",
            description: result.error || "Investor profile generation will continue",
            status: "warning",
            duration: 4000,
          });
        }
      }).catch((err) => {
        setIntelligenceStatus('error');
        console.error("[Profile] Profile intelligence exception:", err);
        toast({
          title: "Profile intelligence failed",
          description: "Investor profile generation will continue",
          status: "warning",
          duration: 4000,
        });
      });
    }

  };

  const handleBack = () => {
    // More robust history check - use browser's history length
    // which is more reliable than React Router's internal state
    if (window.history.length > 2) {
      // There's navigation history, go back
      navigate(-1);
    } else {
      // No meaningful history (only current page or direct access), go to home
      navigate('/');
    }
  };

  // handleSave — directly calls handleSubmit (no <form> tag needed)
  // Used by "Enhance with AI" button — triggers AI generation
  const handleSave = () => {
    if (loading || isProcessing) return;
    if (!userId) {
      toast({ title: "Please wait", description: "Still loading your profile...", status: "info", duration: 3000 });
      return;
    }
    // Call handleSubmit directly — no form element needed
    handleSubmit({ preventDefault: () => {} } as React.FormEvent);
  };

  /**
   * handleSaveChanges — saves manual form edits + AI profile edits to GcpBackend
   * No AI generation calls. Just a simple upsert of editable fields.
   * Also persists AI profile field edits if user modified them.
   * Only enabled when isDirty === true (user has edited something).
   */
  const handleSaveChanges = async () => {
    if (isSaving || !isDirty || !userId) return;

    // Validate required fields before saving
    if (!form.name?.trim()) {
      toast({ title: "Name required", description: "Please enter your name before saving", status: "warning", duration: 3000 });
      return;
    }
    if (form.email?.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(form.email.trim())) {
        toast({ title: "Invalid email", description: "Please enter a valid email address", status: "warning", duration: 3000 });
        return;
      }
    }

    const gcpBackend = resources.config.gcpBackendClient;
    if (!gcpBackend) return;

    setIsSaving(true);
    try {
      // Include AI profile in payload if user edited any AI fields
      const payload: Record<string, unknown> = {};
      if (isAiProfileDirty && investorProfile) {
        payload.investor_profile = investorProfile;
      }
      await saveToSupabase(payload);
      setIsDirty(false);
      setIsAiProfileDirty(false);
      toast({ title: "Changes saved", description: "Your profile details have been updated", status: "success", duration: 3000 });
    } catch (err) {
      console.error("[Profile] Save changes failed:", err);
      toast({ title: "Save failed", description: "Could not save your changes. Please try again.", status: "error", duration: 4000 });
    } finally {
      setIsSaving(false);
    }
  };

  // Handle Apple Wallet pass download
  const handleAppleWalletPass = async () => {
    if (!appleWalletSupported) {
      toast({
        title: "Apple Wallet unavailable",
        description: APPLE_WALLET_SUPPORT_MESSAGE,
        status: "info",
        duration: 4000,
      });
      return;
    }

    if (!form.name) {
      toast({
        title: "Name required",
        description: "Please enter your name to generate a wallet pass",
        status: "warning",
        duration: 3000,
      });
      return;
    }

    setIsApplePassLoading(true);
    try {
      await downloadHushhGoldPass({
        name: form.name,
        email: form.email || null,
        organisation: form.organisation || null,
        slug: profileSlug,
        userId,
        investmentAmount: typeof form.initialInvestmentAmount === "number" ? form.initialInvestmentAmount : null,
      });
      toast({
        title: "Opening Apple Wallet",
        description: "Open the pass preview to add it to Apple Wallet.",
        status: "info",
        duration: 3000,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to generate Apple Wallet pass",
        status: "error",
        duration: 4000,
      });
    } finally {
      setIsApplePassLoading(false);
    }
  };

  // Handle Google Wallet pass
  const handleGoogleWalletPass = async () => {
    if (!googleWalletSupported) {
      toast({
        title: "Google Wallet unavailable",
        description: googleWalletSupportMessage,
        status: "info",
        duration: 4000,
      });
      return;
    }

    if (!form.name) {
      toast({
        title: "Name required",
        description: "Please enter your name to generate a wallet pass",
        status: "warning",
        duration: 3000,
      });
      return;
    }

    setIsGooglePassLoading(true);
    try {
      await launchGoogleWalletPass({
        name: form.name,
        email: form.email || null,
        organisation: form.organisation || null,
        slug: profileSlug,
        userId,
        investmentAmount: typeof form.initialInvestmentAmount === "number" ? form.initialInvestmentAmount : null,
      });
      toast({
        title: "Google Wallet",
        description: "Redirecting to Google Wallet...",
        status: "success",
        duration: 3000,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to generate Google Wallet pass",
        status: "error",
        duration: 4000,
      });
    } finally {
      setIsGooglePassLoading(false);
    }
  };

  // Edge case: show toast when user tries to share without a profile slug
  const warnNoProfileUrl = () => {
    toast({
      title: "Profile not ready",
      description: "Click 'Enhance with AI' first to generate your shareable profile",
      status: "info",
      duration: 4000,
    });
  };

  // Social share handlers — with no-slug feedback
  const handleShareWhatsApp = () => {
    if (!profileUrl) { warnNoProfileUrl(); return; }
    window.open(`https://wa.me/?text=${encodeURIComponent(`Check out my Hushh investor profile: ${profileUrl}`)}`, '_blank');
  };

  const handleShareX = () => {
    if (!profileUrl) { warnNoProfileUrl(); return; }
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(`Check out my Hushh investor profile: ${profileUrl}`)}`, '_blank');
  };

  const handleShareEmail = () => {
    if (!profileUrl) { warnNoProfileUrl(); return; }
    window.location.href = `mailto:?subject=${encodeURIComponent('My Hushh Investor Profile')}&body=${encodeURIComponent(`Check out my investor profile: ${profileUrl}`)}`;
  };

  const handleShareLinkedIn = () => {
    if (!profileUrl) { warnNoProfileUrl(); return; }
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(profileUrl)}`, '_blank');
  };

  const handleOpenProfile = () => {
    if (!profileUrl) { warnNoProfileUrl(); return; }
    window.open(profileUrl, '_blank');
  };

  // UI styles aligned with investor profile design system
  const inputClassName =
    "w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-all focus:border-[#3A63B8] focus:ring-2 focus:ring-[#3A63B8]/20";
  const selectClassName =
    "w-full appearance-none rounded-xl border border-slate-200 bg-white px-4 py-2.5 pr-10 text-sm text-slate-900 outline-none transition-all focus:border-[#3A63B8] focus:ring-2 focus:ring-[#3A63B8]/20";
  const labelClassName =
    "mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500";
  const cardClassName =
    "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5";
  const aiFieldCardTones = [
    "border-blue-100 bg-blue-50/50",
    "border-emerald-100 bg-emerald-50/50",
    "border-purple-100 bg-purple-50/45",
    "border-orange-100 bg-orange-50/45",
    "border-indigo-100 bg-indigo-50/45",
    "border-cyan-100 bg-cyan-50/45",
  ];

  const getConfidenceLabel = (confidence: number) => {
    if (confidence >= 0.7) return "High";
    if (confidence >= 0.4) return "Medium";
    return "Low";
  };

  const getConfidenceBadgeClass = (confidence: number) => {
    if (confidence >= 0.7) {
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    }
    if (confidence >= 0.4) {
      return "border-amber-200 bg-amber-50 text-amber-700";
    }
    return "border-slate-200 bg-white/80 text-slate-600";
  };

  const walletPreview = buildGoldPassPreviewModel({
    name: form.name || "Hushh Investor",
    email: form.email || null,
    organisation: form.organisation || null,
    slug: profileSlug,
    userId,
    investmentAmount:
      typeof form.initialInvestmentAmount === "number"
        ? form.initialInvestmentAmount
        : null,
  });

  return {
    form, setForm, userId, investorProfile, setInvestorProfile, shadowProfile, profileSlug,
    loading, loadingSeconds, isProcessing, investorStatus, intelligenceStatus,
    setLoading, hasOnboardingData, isApplePassLoading, isGooglePassLoading,
    isWalletPreviewOpen, googleWalletSupported, googleWalletSupportMessage,
    appleWalletSupported, appleWalletSupportMessage: APPLE_WALLET_SUPPORT_MESSAGE,
    editingField, setEditingField, nwsResult, nwsLoading,
    isFooterVisible, hasCopied, onCopy, profileUrl, navigate, toast,
    FIELD_OPTIONS, MULTI_SELECT_FIELDS, COUNTRIES, defaultFormState,
    isDirty, isSaving, handleSaveChanges,
    handleUpdateAIField, handleMultiSelectToggle, handleChange, handleSubmit,
    handleBack, handleSave, handleAppleWalletPass, handleGoogleWalletPass,
    openWalletPreview: () => setIsWalletPreviewOpen(true),
    closeWalletPreview: () => setIsWalletPreviewOpen(false),
    walletPreview,
    handleShareWhatsApp, handleShareX, handleShareEmail, handleShareLinkedIn, handleOpenProfile,
    inputClassName, selectClassName, labelClassName, cardClassName,
    aiFieldCardTones, getConfidenceLabel, getConfidenceBadgeClass,
  };
};
