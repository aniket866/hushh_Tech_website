import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet";
import { useToast, useClipboard, Spinner } from "@chakra-ui/react";
import { 
  ArrowLeft, Share2, Link, Copy, Check, ExternalLink, 
  Home, MessageCircle, User, TrendingUp, 
  Target, Clock, Gauge, Droplets, Briefcase, Layers, Zap, Activity,
  Brain, ChevronDown, ChevronUp, Search, Globe, Coffee, Heart, Users, Newspaper, ShieldCheck
} from "lucide-react";
import { FaApple, FaWhatsapp, FaLinkedin, FaGoogle } from "react-icons/fa";
import { FaXTwitter } from "react-icons/fa6";
import { HiMail } from "react-icons/hi";
import HushhTechBackHeader from "../../components/hushh-tech-back-header/HushhTechBackHeader";
import HushhTechCta, { HushhTechCtaVariant } from "../../components/hushh-tech-cta/HushhTechCta";
import { useFooterVisibility } from "../../utils/useFooterVisibility";
import { InvestorChatWidget } from "../../components/InvestorChatWidget";
import WalletCardPreviewModal from "../../components/wallet/WalletCardPreviewModal";
import { fetchPublicInvestorProfileBySlug } from "../../services/investorProfile";
import {
  FIELD_LABELS,
  ONBOARDING_FIELD_LABELS,
  PublicInvestorOnboardingData,
  PublicInvestorProfileRecord,
  VALUE_LABELS,
} from "../../types/investorProfile";
import type { ProfileIntelligence, ShadowProfile } from "../../types/shadowProfile";
import { FINANCIAL_LINK_ROUTE } from "../../services/onboarding/flow";
import {
  APPLE_WALLET_SUPPORT_MESSAGE,
  buildGoldPassPreviewModel,
  downloadHushhGoldPass,
  fetchGoogleWalletAvailability,
  GOOGLE_WALLET_SUPPORT_MESSAGE,
  isAppleWalletSupported,
  launchGoogleWalletPass,
} from "../../services/walletPass";

type TabType = 'home' | 'chat';

const formatGeneratedAt = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
};

const getSourceLabel = (source: ProfileIntelligence["sources"][number]) => {
  if (source.title) return source.title;
  if (source.domain) return source.domain;
  try {
    return new URL(source.url).hostname.replace(/^www\./, "");
  } catch {
    return "Source";
  }
};

const getConfidencePillClass = (label?: string) => {
  if (label === "High") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (label === "Medium") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-gray-50 text-gray-600 border-gray-200";
};

const getIdentityLabel = (label?: string) => {
  if (label === "strong") return "Strong match";
  if (label === "possible") return "Possible match";
  if (label === "ambiguous") return "Ambiguous match";
  return "Low signal";
};

const PublicInvestorProfilePage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [profileData, setProfileData] = useState<PublicInvestorProfileRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('home');
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());
  const [isWalletPreviewOpen, setIsWalletPreviewOpen] = useState(false);
  const [isApplePassLoading, setIsApplePassLoading] = useState(false);
  const [isGooglePassLoading, setIsGooglePassLoading] = useState(false);
  const [googleWalletSupported, setGoogleWalletSupported] = useState(false);
  const [googleWalletSupportMessage, setGoogleWalletSupportMessage] = useState(
    GOOGLE_WALLET_SUPPORT_MESSAGE
  );
  const contentRef = React.useRef<HTMLDivElement>(null);
  const appleWalletSupported = isAppleWalletSupported();

  // Hide global footer on this page (uses its own bottom nav)
  useFooterVisibility();

  // Handle tab change - state change only, scroll handled by useEffect
  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
  };

  // Scroll to top when activeTab changes - ensures scroll happens AFTER React re-renders
  useEffect(() => {
    // Use setTimeout to ensure scroll happens after the DOM is updated with new content
    const timer = setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'instant' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }, 0);
    
    return () => clearTimeout(timer);
  }, [activeTab]);

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
  
  const profileUrl = profileData?.profile_url || (slug ? `https://hushhtech.com/investor/${slug}` : "");
  const { hasCopied, onCopy } = useClipboard(profileUrl);

  useEffect(() => {
    const fetchProfile = async () => {
      if (!slug) {
        navigate('/');
        return;
      }

      try {
        const data = await fetchPublicInvestorProfileBySlug(slug);
        // PD-3 (P2.2): the server-side `get_public_investor_profile` RPC
        // already strips investor_profile / shadow_profile for unconfirmed
        // slugs, so we trust the projection here rather than gate
        // client-side. If we ever want a stricter "paid investor only"
        // policy we should enforce it in the RPC, not duplicate it here.
        setProfileData(data);

        // Send profile view notification email via Vercel API (async, don't wait)
        fetch('/api/send-email-notification', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'profile_view',
            slug,
            profileName: data.basic_info.name
          })
        }).catch(err => console.log('Email notification failed:', err));
        
      } catch (err: any) {
        console.error("Error fetching profile:", err);
        setError(err?.message || "This investor profile doesn't exist or is private");
      } finally {
        setLoading(false);
      }
    };

    fetchProfile();
  }, [slug, navigate, toast]);

  // Toggle field expansion
  const toggleField = (fieldName: string) => {
    setExpandedFields(prev => {
      const next = new Set(prev);
      if (next.has(fieldName)) {
        next.delete(fieldName);
      } else {
        next.add(fieldName);
      }
      return next;
    });
  };

  // Social share handlers
  const handleShareWhatsApp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(`Check out this investor profile: ${profileUrl}`)}`, '_blank');
  };

  const handleShareX = () => {
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(`Check out this investor profile: ${profileUrl}`)}`, '_blank');
  };

  const handleShareEmail = () => {
    window.location.href = `mailto:?subject=${encodeURIComponent('Investor Profile')}&body=${encodeURIComponent(`Check out this investor profile: ${profileUrl}`)}`;
  };

  const handleShareLinkedIn = () => {
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(profileUrl)}`, '_blank');
  };

  const handleOpenProfile = () => {
    window.open(profileUrl, '_blank');
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

  // Get OG image URL
  const ogImageUrl = `${import.meta.env.VITE_GCP_API_BASE_URL}/functions/v1/investor-og-image?slug=${slug}`;

  // Get confidence chip styling
  const getConfidenceChip = (confidence: number) => {
    const label = confidence >= 0.7 ? "High" : confidence >= 0.4 ? "Medium" : "Low";
    const color = confidence >= 0.7 ? "#22C55E" : confidence >= 0.4 ? "#F59E0B" : "#9CA3AF";
    return { label, color };
  };

  // Get icon based on field name
  const getFieldIcon = (fieldName: string) => {
    switch (fieldName) {
      case "primary_goal": return <Target className="w-5 h-5 text-[#2B8CEE]" />;
      case "investment_horizon_years": return <Clock className="w-5 h-5 text-[#2B8CEE]" />;
      case "risk_tolerance": return <Gauge className="w-5 h-5 text-[#2B8CEE]" />;
      case "liquidity_need": return <Droplets className="w-5 h-5 text-[#2B8CEE]" />;
      case "experience_level": return <Briefcase className="w-5 h-5 text-[#2B8CEE]" />;
      case "asset_class_preference": return <Layers className="w-5 h-5 text-[#2B8CEE]" />;
      case "typical_ticket_size": return <Zap className="w-5 h-5 text-[#2B8CEE]" />;
      case "engagement_style": return <Activity className="w-5 h-5 text-[#2B8CEE]" />;
      default: return <TrendingUp className="w-5 h-5 text-[#2B8CEE]" />;
    }
  };

  if (loading) {
    return (
      <div className="bg-white min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Spinner size="xl" color="#2B8CEE" thickness="4px" />
          <p className="text-[#6B7280] mt-4">Loading investor profile...</p>
        </div>
      </div>
    );
  }

  if (!profileData || error) {
    return (
      <div className="bg-white text-gray-900 min-h-screen antialiased flex flex-col selection:bg-hushh-blue selection:text-white">
        <HushhTechBackHeader onBackClick={() => navigate('/')} rightLabel="FAQ" />
        <main className="px-6 flex-grow max-w-md mx-auto w-full flex flex-col items-center justify-center">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-6">
            <User className="w-8 h-8 text-gray-400" />
          </div>
          <h1
            className="text-[2rem] leading-[1.1] font-normal text-black tracking-tight text-center mb-3 font-serif"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            Profile Not Found
          </h1>
          <p className="text-sm text-gray-500 font-medium text-center mb-8">
            This investor profile doesn't exist, is private, or the link may be incorrect.
          </p>
          <div className="w-full space-y-3">
            <HushhTechCta variant={HushhTechCtaVariant.BLACK} onClick={() => navigate('/')}>
              Go to Home
            </HushhTechCta>
            <HushhTechCta variant={HushhTechCtaVariant.WHITE} onClick={() => navigate(FINANCIAL_LINK_ROUTE)}>
              Create Your Own Profile
            </HushhTechCta>
          </div>
        </main>
      </div>
    );
  }

  const basicInfo = profileData.basic_info;
  const isConfirmedProfile =
    typeof profileData.is_confirmed === "boolean"
      ? profileData.is_confirmed
      : Boolean(
          profileData.investor_profile ||
            profileData.onboarding_data ||
            profileData.shadow_profile
        );
  const investorProfile = profileData.investor_profile;
  const shadowProfile: ShadowProfile | null = profileData.shadow_profile;
  const profileIntelligence = shadowProfile?.profileIntelligence;
  const profileIntelligenceSources = profileIntelligence?.sources || [];
  const profileIntelligenceEvidence = profileIntelligence?.evidence?.length
    ? profileIntelligence.evidence
    : profileIntelligenceSources.map((source) => ({
        title: source.title,
        domain: source.domain || getSourceLabel(source),
        url: source.url,
        supports: "Public web signal",
      }));
  const profileIntelligenceSummaryBullets =
    profileIntelligence?.summaryBullets?.length
      ? profileIntelligence.summaryBullets
      : profileIntelligence?.summary
        ? [profileIntelligence.summary]
        : [];
  const profileIntelligencePublicProfiles = profileIntelligence?.publicProfiles || [];
  const profileIntelligenceMissing =
    profileIntelligence?.missingSignals?.length
      ? profileIntelligence.missingSignals
      : profileIntelligence?.missingInformation || [];
  const hasProfileIntelligence = Boolean(
    profileIntelligenceSummaryBullets.length ||
      profileIntelligenceEvidence.length ||
      profileIntelligencePublicProfiles.length
  );
  const hasLegacyShadowProfile = Boolean(
    shadowProfile &&
      !hasProfileIntelligence &&
      (
        shadowProfile.occupation ||
        shadowProfile.nationality ||
        (shadowProfile.netWorthScore || 0) > 0 ||
        (shadowProfile.hobbies?.length || 0) > 0 ||
        (shadowProfile.knownFor?.length || 0) > 0 ||
        (shadowProfile.associates?.length || 0) > 0 ||
        (shadowProfile.socialMedia?.length || 0) > 0
      )
  );
  const onboardingData: PublicInvestorOnboardingData | null = profileData.onboarding_data;
  const displayName = basicInfo.name || "Public Investor";
  const profileEyebrow = isConfirmedProfile
    ? "Verified Investor Profile"
    : "Public Investor Profile";
  const profileBadgeLabel = isConfirmedProfile ? "Verified" : "Public";
  const metaDescription = isConfirmedProfile
    ? `View ${displayName}'s verified investor profile. ${basicInfo.organisation ? `Works at ${basicInfo.organisation}` : ''}`
    : `View ${displayName}'s public investor profile. ${basicInfo.organisation ? `Works at ${basicInfo.organisation}` : ''}`;
  const socialDescription = isConfirmedProfile
    ? `Verified investor on Hushh.${basicInfo.age !== null ? ` Age ${basicInfo.age}` : ''}${basicInfo.organisation ? ` • ${basicInfo.organisation}` : ''}`
    : `Public investor profile on Hushh.${basicInfo.age !== null ? ` Age ${basicInfo.age}` : ''}${basicInfo.organisation ? ` • ${basicInfo.organisation}` : ''}`;
  const secondaryBasicInfoLabel =
    basicInfo.age !== null
      ? `Age ${basicInfo.age}`
      : isConfirmedProfile
        ? "Verified investor"
        : "Shared by investor";
  const visibleInvestorProfileEntries = investorProfile
    ? Object.entries(investorProfile).filter(([, fieldData]) =>
        Boolean(fieldData && typeof fieldData === "object" && "value" in fieldData)
      )
    : [];

  // Filter and format onboarding data for display
  const getVisibleOnboardingFields = () => {
    if (!onboardingData) return [];
    
    const fields: Array<{key: string, label: string, value: any, category: string}> = [];
    
    if (onboardingData.account_type) {
      fields.push({ key: 'account_type', label: ONBOARDING_FIELD_LABELS.account_type, value: VALUE_LABELS[onboardingData.account_type] || onboardingData.account_type, category: 'Basic Information' });
    }
    if (onboardingData.selected_fund) {
      fields.push({ key: 'selected_fund', label: ONBOARDING_FIELD_LABELS.selected_fund, value: onboardingData.selected_fund, category: 'Basic Information' });
    }
    if (onboardingData.citizenship_country) {
      fields.push({ key: 'citizenship_country', label: ONBOARDING_FIELD_LABELS.citizenship_country, value: onboardingData.citizenship_country, category: 'Location' });
    }
    if (onboardingData.residence_country) {
      fields.push({ key: 'residence_country', label: ONBOARDING_FIELD_LABELS.residence_country, value: onboardingData.residence_country, category: 'Location' });
    }
    
    return fields;
  };

  const visibleOnboardingFields = getVisibleOnboardingFields();
  const walletPassInput = {
    name: basicInfo.name || "Hushh Investor",
    organisation: basicInfo.organisation || null,
    slug: profileData.slug || slug || null,
  };
  const walletPreview = buildGoldPassPreviewModel(walletPassInput);

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

    setIsApplePassLoading(true);
    try {
      await downloadHushhGoldPass(walletPassInput);
      toast({
        title: "Opening Apple Wallet",
        description: "Open the pass preview to add it to Apple Wallet.",
        status: "info",
        duration: 3000,
      });
    } catch (error) {
      toast({
        title: "Apple Wallet failed",
        description:
          error instanceof Error ? error.message : "Failed to generate Apple Wallet pass",
        status: "error",
        duration: 4000,
      });
    } finally {
      setIsApplePassLoading(false);
    }
  };

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

    setIsGooglePassLoading(true);
    try {
      await launchGoogleWalletPass(walletPassInput);
      toast({
        title: "Google Wallet",
        description: "Redirecting to Google Wallet...",
        status: "success",
        duration: 3000,
      });
    } catch (error) {
      toast({
        title: "Google Wallet failed",
        description:
          error instanceof Error ? error.message : "Failed to generate Google Wallet pass",
        status: "error",
        duration: 4000,
      });
    } finally {
      setIsGooglePassLoading(false);
    }
  };

  return (
    <>
      <Helmet>
        <title>{`${displayName}'s Investor Profile | Hushh`}</title>
        <meta name="description" content={metaDescription} />
        <meta property="og:title" content={`${displayName} - Investor Profile`} />
        <meta property="og:description" content={socialDescription} />
        <meta property="og:image" content={ogImageUrl} />
        <meta property="og:url" content={profileUrl} />
        <meta property="og:type" content="profile" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={`${displayName} - Investor Profile`} />
        <meta name="twitter:description" content={socialDescription} />
        <meta name="twitter:image" content={ogImageUrl} />
      </Helmet>

      <div className="bg-white text-gray-900 min-h-screen antialiased flex flex-col selection:bg-hushh-blue selection:text-white">
        {/* Hushh Design System Header */}
        <HushhTechBackHeader
          onBackClick={handleBack}
          rightType="hamburger"
        />

        <main className="px-6 flex-grow max-w-md mx-auto w-full pb-48">
            
            {/* HOME TAB CONTENT */}
            {activeTab === 'home' && (
              <>
                {/* Wallet Buttons - Top */}
                <section className="pt-4 sm:pt-6 pb-2">
                  <div className="flex flex-col min-[380px]:flex-row items-stretch min-[380px]:items-center justify-center gap-3 min-[380px]:gap-4">
                    <button
                      onClick={handleAppleWalletPass}
                      disabled={isApplePassLoading || !appleWalletSupported}
                      className="flex min-w-0 items-center justify-center gap-2.5 px-4 py-3 min-[380px]:px-6 bg-[#F5F5F5] rounded-full hover:bg-gray-200 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Add to Apple Wallet"
                    >
                      <FaApple className="w-5 h-5 shrink-0 text-black" />
                      <span className="text-sm font-medium text-black whitespace-nowrap">
                        {isApplePassLoading ? "Loading..." : "Apple Wallet"}
                      </span>
                    </button>
                    <button
                      onClick={handleGoogleWalletPass}
                      disabled={isGooglePassLoading || !googleWalletSupported}
                      className="flex min-w-0 items-center justify-center gap-2.5 px-4 py-3 min-[380px]:px-6 bg-[#F5F5F5] rounded-full hover:bg-gray-200 active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Add to Google Wallet"
                    >
                      <FaGoogle className="w-4 h-4 shrink-0" style={{ color: '#4285F4' }} />
                      <span className="text-sm font-medium text-black whitespace-nowrap">
                        {isGooglePassLoading ? "Loading..." : "Google Wallet"}
                      </span>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsWalletPreviewOpen(true)}
                    className="mt-3 w-full border border-gray-200 rounded-full px-5 py-3 text-sm font-medium text-black hover:bg-gray-50 transition-colors"
                  >
                    View Hushh Gold Pass
                  </button>
                  {!appleWalletSupported && (
                    <p className="mt-3 text-center text-xs text-gray-500 font-light">
                      {APPLE_WALLET_SUPPORT_MESSAGE}
                    </p>
                  )}
                  {!googleWalletSupported && (
                    <p className="mt-2 text-center text-xs text-gray-500 font-light">
                      {googleWalletSupportMessage}
                    </p>
                  )}
                </section>

                {/* Welcome Section */}
                <section className="py-8">
                  <p className="text-[10px] tracking-[0.2em] text-gray-400 uppercase mb-4 font-medium">
                    {profileEyebrow}
                  </p>
                  <h1
                    className="text-[2.75rem] leading-[1.1] font-normal text-black tracking-tight font-serif"
                    style={{ fontFamily: "'Playfair Display', serif" }}
                  >
                    {displayName} <br />
                    <span className="text-gray-400 italic font-light">Investor Profile</span>
                  </h1>
                </section>

                {/* Profile Details */}
                <section className="mb-8 space-y-0">
                  <div className="py-4 border-b border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                        <User className="w-5 h-5 text-gray-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{displayName}</p>
                        <p className="text-xs text-gray-500 font-medium">{secondaryBasicInfoLabel}</p>
                      </div>
                    </div>
                    <span className="px-2.5 py-1 bg-hushh-blue/10 text-hushh-blue text-[10px] font-semibold rounded-full">
                      {profileBadgeLabel}
                    </span>
                  </div>
                  <div className="py-4 border-b border-gray-200 flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                      <span className="material-symbols-outlined text-gray-600 text-xl" style={{ fontVariationSettings: "'wght' 400" }}>mail</span>
                    </div>
                      <div className="min-w-0 flex-1">
                        <p
                          className="text-sm font-semibold text-gray-900 whitespace-normal break-words"
                          style={{ overflowWrap: "anywhere" }}
                          data-testid="profile-email-value"
                        >
                          {basicInfo.email || 'Contact hidden'}
                        </p>
                        <p className="text-xs text-gray-500 font-medium">Contact masked for privacy</p>
                      </div>
                    </div>
                  {basicInfo.organisation && (
                    <div className="py-4 border-b border-gray-200 flex items-center gap-4">
                      <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                        <Briefcase className="w-5 h-5 text-gray-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{basicInfo.organisation}</p>
                        <p className="text-xs text-gray-500 font-medium">Organisation</p>
                      </div>
                    </div>
                  )}
                </section>

                {/* Share Section */}
                <section className="mb-8">
                  <div className="flex items-center justify-between mb-6">
                    <h2
                      className="text-xl text-black font-normal font-serif"
                      style={{ fontFamily: "'Playfair Display', serif" }}
                    >
                      Share Profile
                    </h2>
                    <button
                      onClick={handleOpenProfile}
                      className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                      aria-label="Open profile"
                    >
                      <ExternalLink className="w-4 h-4 text-gray-500" />
                    </button>
                  </div>

                  {/* Profile URL */}
                  <div className="py-4 border-b border-gray-200 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                      <Link className="w-4 h-4 text-gray-700" />
                    </div>
                    <span className="text-sm text-gray-700 truncate flex-1">{profileUrl}</span>
                    <button onClick={onCopy} className="p-2 hover:bg-gray-100 rounded-full transition-colors" aria-label="Copy link">
                      {hasCopied ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5 text-gray-400" />}
                    </button>
                  </div>

                  {/* Share via Social */}
                  <div className="py-4 border-b border-gray-200">
                    <p className="text-xs text-gray-500 font-medium mb-3">Share via</p>
                    <div className="flex items-center gap-3">
                      <button onClick={handleShareWhatsApp} className="w-10 h-10 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-colors" aria-label="WhatsApp">
                        <FaWhatsapp className="w-5 h-5 text-gray-700" />
                      </button>
                      <button onClick={handleShareX} className="w-10 h-10 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-colors" aria-label="X">
                        <FaXTwitter className="w-5 h-5 text-gray-700" />
                      </button>
                      <button onClick={handleShareEmail} className="w-10 h-10 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-colors" aria-label="Email">
                        <HiMail className="w-5 h-5 text-gray-700" />
                      </button>
                      <button onClick={handleShareLinkedIn} className="w-10 h-10 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-colors" aria-label="LinkedIn">
                        <FaLinkedin className="w-5 h-5 text-gray-700" />
                      </button>
                    </div>
                  </div>

                </section>

                {/* AI Generated Investment Profile */}
                {visibleInvestorProfileEntries.length > 0 && (
                  <section className="mb-8">
                    <div className="flex items-center justify-between mb-6">
                      <h2
                        className="text-xl text-black font-normal font-serif"
                        style={{ fontFamily: "'Playfair Display', serif" }}
                      >
                        Investment Profile
                      </h2>
                      <span className="px-2.5 py-1 bg-hushh-blue/10 text-hushh-blue text-[10px] font-semibold rounded-full uppercase tracking-wide">
                        AI Analyzed
                      </span>
                    </div>
                    <div className="space-y-0">
                      {visibleInvestorProfileEntries.map(([fieldName, fieldData]: [string, any]) => {
                        const label = FIELD_LABELS[fieldName as keyof typeof FIELD_LABELS] || fieldName;
                        const valueText = Array.isArray(fieldData.value)
                          ? fieldData.value.map((v: string) => VALUE_LABELS[v as keyof typeof VALUE_LABELS] || v).join(", ")
                          : VALUE_LABELS[fieldData.value as keyof typeof VALUE_LABELS] || fieldData.value;
                        const { label: confLabel, color: confColor } = getConfidenceChip(fieldData.confidence || 0);
                        const isExpanded = expandedFields.has(fieldName);

                        return (
                          <div
                            key={fieldName}
                            className="py-4 border-b border-gray-200"
                            data-testid="profile-metadata-row"
                          >
                            <button
                              onClick={() => toggleField(fieldName)}
                              className="w-full flex items-start gap-3 text-left sm:items-center sm:gap-4"
                            >
                              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                                {getFieldIcon(fieldName)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-gray-900 mb-0.5 whitespace-normal break-words">
                                  {label}
                                </p>
                                <p
                                  className="text-xs text-gray-500 font-medium leading-relaxed whitespace-normal break-words"
                                  style={{ overflowWrap: "anywhere" }}
                                  data-testid="profile-metadata-value"
                                >
                                  {valueText}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
                                <span
                                  className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                  style={{ backgroundColor: `${confColor}15`, color: confColor }}
                                >
                                  {confLabel}
                                </span>
                                {isExpanded ? (
                                  <ChevronUp className="w-4 h-4 text-gray-400" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 text-gray-400" />
                                )}
                              </div>
                            </button>
                            {isExpanded && fieldData.rationale && (
                              <div className="mt-3 ml-0 sm:ml-14">
                                <p
                                  className="text-xs text-gray-500 italic mb-2 leading-relaxed whitespace-normal break-words"
                                  style={{ overflowWrap: "anywhere" }}
                                >
                                  {fieldData.rationale}
                                </p>
                                <div className="h-0.5 bg-gray-200 rounded-full overflow-hidden">
                                  <div
                                    className="h-full transition-all duration-500"
                                    style={{ width: `${Math.round((fieldData.confidence || 0) * 100)}%`, backgroundColor: confColor }}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {hasProfileIntelligence && profileIntelligence && (
                  <section className="mb-8 border border-gray-200 rounded-2xl p-5 bg-white">
                    <div className="flex items-start justify-between gap-4 mb-5">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full bg-hushh-blue/10 flex items-center justify-center shrink-0">
                          <Brain className="w-5 h-5 text-hushh-blue" />
                        </div>
                        <div className="min-w-0">
                          <h2 className="text-lg font-semibold text-gray-900">Public Signals</h2>
                          <p className="text-xs text-gray-500">Safe profile intelligence</p>
                        </div>
                      </div>
                      <span className={`px-2.5 py-1 text-[10px] font-semibold rounded-full uppercase tracking-wide border ${getConfidencePillClass(profileIntelligence.confidenceLabel)}`}>
                        {profileIntelligence.confidenceLabel || "Low"}
                      </span>
                    </div>

                    {(profileIntelligence.headline || profileIntelligence.generatedAt) && (
                      <div className="mb-5 rounded-xl border border-gray-100 bg-gray-50 px-3 py-3">
                        {profileIntelligence.headline && (
                          <p className="text-sm font-medium text-gray-900 leading-relaxed">
                            {profileIntelligence.headline}
                          </p>
                        )}
                        {(profileIntelligence.generatedAt || profileIntelligence.model) && (
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-400">
                            {profileIntelligence.generatedAt && (
                              <span>{formatGeneratedAt(profileIntelligence.generatedAt)}</span>
                            )}
                            {profileIntelligence.model && <span>{profileIntelligence.model}</span>}
                          </div>
                        )}
                      </div>
                    )}

                    {profileIntelligenceSummaryBullets.length > 0 && (
                      <div className="mb-5">
                        <div className="space-y-2">
                          {profileIntelligenceSummaryBullets.slice(0, 4).map((item) => (
                            <div key={item} className="flex gap-2 text-sm text-gray-700 leading-relaxed">
                              <Check className="mt-0.5 w-4 h-4 shrink-0 text-emerald-500" />
                              <span>{item}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {profileIntelligence.identityMatch && (
                      <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50/50 px-3 py-3">
                        <div className="flex items-start gap-2">
                          <ShieldCheck className="mt-0.5 w-4 h-4 shrink-0 text-hushh-blue" />
                          <div>
                            <p className="text-sm font-medium text-gray-900">
                              {getIdentityLabel(profileIntelligence.identityMatch.label)}
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-gray-500">
                              {profileIntelligence.identityMatch.explanation}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {profileIntelligencePublicProfiles.length > 0 && (
                      <div className="mb-5">
                        <div className="flex items-center gap-2 mb-3">
                          <User className="w-4 h-4 text-hushh-blue" />
                          <span className="text-sm font-medium text-gray-800">Public profiles</span>
                        </div>
                        <div className="space-y-2">
                          {profileIntelligencePublicProfiles.slice(0, 3).map((profile) => (
                            <a
                              key={profile.url}
                              href={profile.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2 text-sm hover:border-hushh-blue/30"
                            >
                              <div className="min-w-0">
                                <p className="truncate font-medium text-gray-900">{profile.platform}</p>
                                <p className="truncate text-xs text-gray-500">{profile.title}</p>
                              </div>
                              <ExternalLink className="w-3.5 h-3.5 shrink-0 text-hushh-blue" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {profileIntelligenceEvidence.length > 0 && (
                      <div className="mb-5">
                        <div className="flex items-center gap-2 mb-3">
                          <Globe className="w-4 h-4 text-hushh-blue" />
                          <span className="text-sm font-medium text-gray-800">Cited evidence</span>
                        </div>
                        <div className="space-y-2">
                          {profileIntelligenceEvidence.slice(0, 4).map((source) => (
                            <a
                              key={source.url}
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2 text-sm text-hushh-blue hover:border-hushh-blue/30"
                            >
                              <span className="min-w-0 truncate">{source.title} · {source.supports}</span>
                              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {profileIntelligenceMissing.length > 0 && (
                      <div className="mb-5">
                        <div className="flex items-center gap-2 mb-3">
                          <Search className="w-4 h-4 text-amber-500" />
                          <span className="text-sm font-medium text-gray-800">Missing signals</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {profileIntelligenceMissing.slice(0, 6).map((item) => (
                            <span key={item} className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-700">
                              {item}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {/* Shadow Profile Deep Intelligence Section */}
                {hasLegacyShadowProfile && shadowProfile && (
                  <section className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-2xl p-5 shadow-lg border border-slate-700">
                    <div className="flex items-center justify-between mb-5">
                      <div className="flex items-center gap-3">
                        <Search className="w-6 h-6 text-purple-400" />
                        <div>
                          <h2 className="text-lg font-semibold text-white">Deep Profile Intelligence</h2>
                          <p className="text-xs text-slate-400">Powered by Shadow Investigator AI</p>
                        </div>
                      </div>
                      <span className="text-xs font-medium px-3 py-1 rounded-full bg-purple-500/20 text-purple-300">
                        {Math.round((shadowProfile.confidence || 0) * 100)}% Confidence
                      </span>
                    </div>

                    {/* Identity Section */}
                    <div className="mb-5">
                      <div className="flex items-center gap-2 mb-3">
                        <User className="w-4 h-4 text-blue-400" />
                        <span className="text-sm font-medium text-blue-300">Identity & Demographics</span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {shadowProfile.occupation && (
                          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
                            <span className="text-xs text-slate-400">Occupation</span>
                            <p className="text-sm text-white font-medium">{shadowProfile.occupation}</p>
                          </div>
                        )}
                        {shadowProfile.nationality && (
                          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
                            <span className="text-xs text-slate-400">Nationality</span>
                            <p className="text-sm text-white font-medium">{shadowProfile.nationality}</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Net Worth Section */}
                    {(shadowProfile.netWorthScore || 0) > 0 && (
                      <div className="mb-5 bg-gradient-to-r from-amber-500/10 to-yellow-500/10 rounded-xl p-4 border border-amber-500/20">
                        <div className="flex items-center gap-2 mb-2">
                          <TrendingUp className="w-4 h-4 text-amber-400" />
                          <span className="text-sm font-medium text-amber-300">Wealth Analysis</span>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="flex-1">
                            <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-gradient-to-r from-amber-400 to-yellow-400 rounded-full"
                                style={{ width: `${Math.min(shadowProfile.netWorthScore || 0, 100)}%` }}
                              />
                            </div>
                          </div>
                          <span className="text-lg font-bold text-amber-400">{shadowProfile.netWorthScore || 0}/100</span>
                        </div>
                      </div>
                    )}

                    {/* Hobbies & Interests */}
                    {shadowProfile.hobbies && shadowProfile.hobbies.length > 0 && (
                      <div className="mb-5">
                        <div className="flex items-center gap-2 mb-3">
                          <Heart className="w-4 h-4 text-pink-400" />
                          <span className="text-sm font-medium text-pink-300">Hobbies & Interests</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {shadowProfile.hobbies.map((hobby, idx) => (
                            <span key={idx} className="text-xs px-2 py-1 bg-pink-500/20 text-pink-300 rounded-full">
                              {hobby}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Known For */}
                    {shadowProfile.knownFor && shadowProfile.knownFor.length > 0 && (
                      <div className="mb-5">
                        <div className="flex items-center gap-2 mb-3">
                          <Zap className="w-4 h-4 text-yellow-400" />
                          <span className="text-sm font-medium text-yellow-300">Known For</span>
                        </div>
                        <div className="space-y-2">
                          {shadowProfile.knownFor.slice(0, 3).map((item, idx) => (
                            <div key={idx} className="bg-yellow-500/10 rounded-lg p-2 border border-yellow-500/20">
                              <p className="text-sm text-yellow-100">{item}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Key Network */}
                    {shadowProfile.associates && shadowProfile.associates.length > 0 && (
                      <div className="mb-5">
                        <div className="flex items-center gap-2 mb-3">
                          <Users className="w-4 h-4 text-green-400" />
                          <span className="text-sm font-medium text-green-300">Key Network</span>
                        </div>
                        <div className="space-y-2">
                          {shadowProfile.associates.slice(0, 3).map((associate, idx) => (
                            <div key={idx} className="flex items-center justify-between bg-slate-800/50 rounded-lg p-2 border border-slate-700">
                              <div>
                                <p className="text-sm text-white font-medium">{associate.name}</p>
                                <p className="text-xs text-slate-400">{associate.relation}</p>
                              </div>
                              <span className={`text-xs px-2 py-0.5 rounded-full ${
                                associate.category === 'INNER' ? 'bg-green-500/20 text-green-300' :
                                associate.category === 'ORBIT' ? 'bg-blue-500/20 text-blue-300' :
                                'bg-purple-500/20 text-purple-300'
                              }`}>
                                {associate.category}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Social Profiles */}
                    {shadowProfile.socialMedia && shadowProfile.socialMedia.length > 0 && (
                      <div className="pt-4 border-t border-slate-700">
                        <div className="flex items-center gap-2 mb-3">
                          <Globe className="w-4 h-4 text-cyan-400" />
                          <span className="text-sm font-medium text-cyan-300">Social Profiles</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {shadowProfile.socialMedia.map((social, idx) => (
                            <a
                              key={idx}
                              href={social.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs px-3 py-1.5 bg-cyan-500/20 text-cyan-300 rounded-full hover:bg-cyan-500/30 transition-colors"
                            >
                              {social.platform}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {/* Personal Information */}
                {visibleOnboardingFields.length > 0 && (
                  <section className="mb-8">
                    <h2
                      className="text-xl text-black font-normal font-serif mb-6"
                      style={{ fontFamily: "'Playfair Display', serif" }}
                    >
                      Personal Information
                    </h2>
                    <div className="space-y-0">
                      {visibleOnboardingFields.map((field) => (
                        <div
                          key={field.key}
                          className="py-4 border-b border-gray-200 flex items-center justify-between"
                        >
                          <span className="text-sm text-gray-500 font-medium">{field.label}</span>
                          <span className="text-sm font-semibold text-gray-900">{field.value}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* CTA to create own profile */}
                <section className="mb-8 space-y-3">
                  <h2
                    className="text-xl text-black font-normal font-serif mb-2"
                    style={{ fontFamily: "'Playfair Display', serif" }}
                  >
                    Create Your Profile
                  </h2>
                  <p className="text-xs text-gray-500 font-medium mb-4">
                    Get your AI-powered investor profile in minutes
                  </p>
                  <HushhTechCta variant={HushhTechCtaVariant.BLACK} onClick={() => navigate(FINANCIAL_LINK_ROUTE)}>
                    Create Your Hushh ID
                  </HushhTechCta>
                  <HushhTechCta variant={HushhTechCtaVariant.WHITE} onClick={() => navigate("/")}>
                    Back to Home
                  </HushhTechCta>
                </section>

                {/* Trust Badges */}
                <section className="flex flex-col items-center justify-center text-center gap-2 pb-8">
                  <div className="flex items-center gap-1">
                    <span className="material-symbols-outlined text-[12px] text-hushh-blue">lock</span>
                    <span className="text-[10px] text-gray-500 tracking-wide uppercase font-medium">256 Bit Encryption</span>
                  </div>
                </section>
              </>
            )}

            {/* CHAT TAB CONTENT */}
            {activeTab === 'chat' && (
              <div className="flex-1">
                <InvestorChatWidget slug={slug!} investorName={basicInfo.name} />
              </div>
            )}


          {/* Bottom Navigation Bar - Black */}
          <div
            aria-hidden="true"
            className="h-[calc(5.75rem+env(safe-area-inset-bottom,0px))] shrink-0"
          />
          <nav className="fixed bottom-0 left-0 right-0 bg-black border-t border-gray-800 z-20">
            <div className="max-w-md mx-auto flex items-center justify-around py-2 px-4 safe-bottom">
              <button
                onClick={() => handleTabChange('home')}
                className={`flex flex-col items-center gap-1 py-2 px-4 rounded-lg transition-colors ${
                  activeTab === 'home' 
                    ? 'text-[#2B8CEE]' 
                    : 'text-gray-400 hover:text-gray-300'
                }`}
              >
                <Home className="w-5 h-5" />
                <span className="text-xs font-medium">Home</span>
              </button>
              <button
                onClick={() => handleTabChange('chat')}
                className={`flex flex-col items-center gap-1 py-2 px-4 rounded-lg transition-colors ${
                  activeTab === 'chat' 
                    ? 'text-[#2B8CEE]' 
                    : 'text-gray-400 hover:text-gray-300'
                }`}
              >
                <MessageCircle className="w-5 h-5" />
                <span className="text-xs font-medium">Chat</span>
              </button>
            </div>
          </nav>
        </main>
      </div>
      <WalletCardPreviewModal
        isOpen={isWalletPreviewOpen}
        onClose={() => setIsWalletPreviewOpen(false)}
        preview={walletPreview}
        appleWalletSupported={appleWalletSupported}
        appleWalletSupportMessage={APPLE_WALLET_SUPPORT_MESSAGE}
        onAddToAppleWallet={handleAppleWalletPass}
        isApplePassLoading={isApplePassLoading}
        googleWalletAvailable={googleWalletSupported}
        googleWalletSupportMessage={googleWalletSupportMessage}
        onAddToGoogleWallet={handleGoogleWalletPass}
        isGooglePassLoading={isGooglePassLoading}
      />
    </>
  );
};

export default PublicInvestorProfilePage;
