import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@chakra-ui/react";
import {
  createInvestorProfile,
  updateInvestorProfile,
  fetchInvestorProfile,
} from "../../services/investorProfile";
import {
  InvestorProfileInput,
  InvestorProfileRecord,
  InvestorProfile,
} from "../../types/investorProfile";
import resources from "../../resources/resources";
import {
  APPLE_WALLET_SUPPORT_MESSAGE,
  buildGoldPassPreviewModel,
  downloadHushhGoldPass,
  fetchGoogleWalletAvailability,
  GOOGLE_WALLET_SUPPORT_MESSAGE,
  isAppleWalletSupported,
  launchGoogleWalletPass,
} from "../../services/walletPass";

export type FlowStep = "loading" | "form" | "review" | "complete";

export function useInvestorProfileLogic() {
  const [step, setStep] = useState<FlowStep>("loading");
  const [isProcessing, setIsProcessing] = useState(false);
  const [profile, setProfile] = useState<InvestorProfileRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userData, setUserData] = useState<{ name: string; email: string } | null>(null);
  const [isApplePassLoading, setIsApplePassLoading] = useState(false);
  const [isGooglePassLoading, setIsGooglePassLoading] = useState(false);
  const [walletPassReady, setWalletPassReady] = useState(false);
  const [isWalletPreviewOpen, setIsWalletPreviewOpen] = useState(false);
  const [googleWalletSupported, setGoogleWalletSupported] = useState(false);
  const [googleWalletSupportMessage, setGoogleWalletSupportMessage] = useState(
    GOOGLE_WALLET_SUPPORT_MESSAGE
  );
  const navigate = useNavigate();
  const toast = useToast();
  const passReady = walletPassReady;
  const appleWalletSupported = isAppleWalletSupported();

  // Check if user is authenticated and if profile already exists
  useEffect(() => {
    const checkExistingProfile = async () => {
      try {
        const gcpBackend = resources.config.gcpBackendClient;
        if (!gcpBackend) {
          throw new Error("GcpBackend client not initialized");
        }

        // Check authentication
        const {
          data: { user },
          error: authError,
        } = await gcpBackend.auth.getUser();

        if (authError || !user) {
          navigate("/login");
          return;
        }

        // Extract user data from OAuth (Google, etc.)
        const userName =
          user.user_metadata?.full_name || user.user_metadata?.name || "";
        const userEmail = user.email || "";

        setUserData({
          name: userName,
          email: userEmail,
        });

        // Check if profile exists
        const existingProfile = await fetchInvestorProfile();

        if (existingProfile) {
          if (existingProfile.user_confirmed) {
            navigate("/hushh-user-profile");
          } else {
            setProfile(existingProfile);
            setStep("review");
          }
        } else {
          setStep("form");
        }
      } catch (err) {
        console.error("Error checking profile:", err);
        setError(err instanceof Error ? err.message : "Failed to check profile");
        setStep("form");
      }
    };

    checkExistingProfile();
  }, [navigate]);

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

  const triggerWalletPassDownload = async (
    wallet: "apple" | "google",
    setLoading: (value: boolean) => void
  ) => {
    if (!profile) return;
    if (wallet === "apple" && !appleWalletSupported) {
      toast({
        title: "Apple Wallet unavailable",
        description: APPLE_WALLET_SUPPORT_MESSAGE,
        status: "info",
        duration: 4000,
      });
      return;
    }

    if (wallet === "google" && !googleWalletSupported) {
      toast({
        title: "Google Wallet unavailable",
        description: googleWalletSupportMessage,
        status: "info",
        duration: 4000,
      });
      return;
    }

    setLoading(true);
    try {
      if (wallet === "apple") {
        await downloadHushhGoldPass({
          name: profile.name,
          email: profile.email,
          organisation: profile.organisation,
          slug: profile.slug,
          userId: profile.user_id,
        });
      } else {
        await launchGoogleWalletPass({
          name: profile.name,
          email: profile.email,
          organisation: profile.organisation,
          slug: profile.slug,
          userId: profile.user_id,
        });
      }

      setWalletPassReady(true);
      toast({
        title:
          wallet === "apple"
            ? "Opening Apple Wallet"
            : "Redirecting to Google Wallet",
        description:
          wallet === "apple"
            ? "Open the pass preview to add it to Apple Wallet."
            : "Complete the save flow in Google Wallet.",
        status: "info",
        duration: 4000,
      });
    } catch (err) {
      toast({
        title: `${wallet === "apple" ? "Apple" : "Google"} Wallet card failed`,
        description:
          err instanceof Error
            ? err.message
            : "Could not generate your Hushh Gold pass.",
        status: "error",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleFormSubmit = async (input: InvestorProfileInput) => {
    setIsProcessing(true);
    setError(null);

    try {
      const newProfile = await createInvestorProfile(input);
      setProfile(newProfile);
      setStep("review");
    } catch (err) {
      console.error("Error creating profile:", err);
      setError(err instanceof Error ? err.message : "Failed to create profile");
      throw err;
    } finally {
      setIsProcessing(false);
    }
  };

  const handleProfileConfirm = async (updates: Partial<InvestorProfile>) => {
    if (!profile) return;

    setIsProcessing(true);
    setError(null);

    try {
      await updateInvestorProfile({
        investor_profile: updates,
        user_confirmed: true,
      });

      setStep("complete");
      if (appleWalletSupported) {
        await triggerWalletPassDownload("apple", setIsApplePassLoading);
      }
    } catch (err) {
      console.error("Error confirming profile:", err);
      setError(
        err instanceof Error ? err.message : "Failed to confirm profile"
      );
      throw err;
    } finally {
      setIsProcessing(false);
    }
  };

  const profileUrl = profile?.slug
    ? `https://hushhtech.com/investor/${profile.slug}`
    : "";

  const handleCopyURL = () => {
    navigator.clipboard.writeText(profileUrl);
    toast({
      title: "Link copied!",
      description: "Share it with anyone",
      status: "success",
      duration: 2000,
    });
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${profile?.name}'s Investor Profile`,
          text: "Check out my investor profile on Hushh",
          url: profileUrl,
        });
      } catch (err) {
        handleCopyURL();
      }
    } else {
      handleCopyURL();
    }
  };

  const handleAppleWalletDownload = () =>
    triggerWalletPassDownload("apple", setIsApplePassLoading);

  const handleGoogleWalletDownload = () =>
    triggerWalletPassDownload("google", setIsGooglePassLoading);

  const walletPreview =
    profile &&
    buildGoldPassPreviewModel({
      name: profile.name,
      email: profile.email,
      organisation: profile.organisation,
      slug: profile.slug,
      userId: profile.user_id,
    });

  return {
    step,
    isProcessing,
    profile,
    error,
    userData,
    isApplePassLoading,
    isGooglePassLoading,
    isWalletPreviewOpen,
    appleWalletSupported,
    appleWalletSupportMessage: APPLE_WALLET_SUPPORT_MESSAGE,
    googleWalletSupported,
    googleWalletSupportMessage,
    passReady,
    profileUrl,
    walletPreview,
    handleFormSubmit,
    handleProfileConfirm,
    handleCopyURL,
    handleShare,
    handleAppleWalletDownload,
    handleGoogleWalletDownload,
    openWalletPreview: () => setIsWalletPreviewOpen(true),
    closeWalletPreview: () => setIsWalletPreviewOpen(false),
  };
}
