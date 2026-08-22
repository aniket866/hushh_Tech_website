import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@chakra-ui/react";
import resources from "../../resources/resources";
import { PrivacySettings } from "../../types/investorProfile";
import { useAuthSession } from "../../auth/AuthSessionProvider";
import { buildLoginRedirectPath } from "../../auth/routePolicy";

export const TOKENS = {
  label: "#000000",
  secondary: "#6E6E73",
  tertiary: "#8E8E93",
  separator: "#E5E5EA",
  blue: "#0A84FF",
  green: "#34C759",
  red: "#FF3B30",
} as const;

function getDefaultPrivacySettings(): PrivacySettings {
  return {
    investor_profile: {
      primary_goal: { value: true } as any,
      investment_horizon_years: { value: true } as any,
      risk_tolerance: { value: true } as any,
      liquidity_need: { value: true } as any,
      experience_level: { value: true } as any,
      typical_ticket_size: { value: true } as any,
      annual_investing_capacity: { value: true } as any,
      asset_class_preference: { value: true } as any,
      sector_preferences: { value: true } as any,
      volatility_reaction: { value: true } as any,
      sustainability_preference: { value: true } as any,
      engagement_style: { value: true } as any,
    },
    onboarding_data: {
      account_type: true,
      selected_fund: true,
      referral_source: true,
      referral_source_other: true,
      citizenship_country: true,
      residence_country: true,
      account_structure: true,
      phone_number: true,
      phone_country_code: true,
      legal_first_name: true,
      legal_last_name: true,
      address_line_1: true,
      address_line_2: true,
      address_country: true,
      city: true,
      state: true,
      zip_code: true,
      address_phone_number: true,
      address_phone_country_code: true,
      date_of_birth: true,
      ssn_encrypted: false, // SSN default OFF
      initial_investment_amount: true,
      recurring_investment_enabled: true,
      recurring_frequency: true,
      recurring_amount: true,
      recurring_day_of_month: true,
    },
    basic_info: {
      name: true,
      email: true,
      age: true,
      organisation: true,
    },
  };
}

export function usePrivacyControlsLogic() {
  const navigate = useNavigate();
  const toast = useToast();
  const { status, user } = useAuthSession();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [privacySettings, setPrivacySettings] = useState<PrivacySettings | null>(null);

  useEffect(() => {
    const fetchPrivacySettings = async () => {
      try {
        if (status === "booting") {
          return;
        }

        const gcpBackend = resources.config.gcpBackendClient;
        if (!gcpBackend) {
          throw new Error("GcpBackend client not available");
        }

        if (status !== "authenticated" || !user) {
          toast({
            title: "Authentication Required",
            description: "Please log in to manage privacy settings",
            status: "error",
            duration: 5000,
          });
          navigate(buildLoginRedirectPath('/hushh-user-profile/privacy'), { replace: true });
          return;
        }

        const { data, error } = await gcpBackend
          .from("investor_profiles")
          .select("privacy_settings")
          .eq("user_id", user.id)
          .maybeSingle();

        if (error) throw error;

        setPrivacySettings(data.privacy_settings || getDefaultPrivacySettings());
      } catch (error: any) {
        console.error("Error fetching privacy settings:", error);
        toast({
          title: "Error",
          description: "Failed to load privacy settings",
          status: "error",
          duration: 5000,
        });
      } finally {
        setLoading(false);
      }
    };

    void fetchPrivacySettings();
  }, [navigate, status, toast, user]);

  const handleToggle = (section: keyof PrivacySettings, field: string) => {
    if (!privacySettings) return;

    setPrivacySettings({
      ...privacySettings,
      [section]: {
        ...privacySettings[section],
        [field]: !privacySettings[section][field as keyof typeof privacySettings[typeof section]],
      },
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const gcpBackend = resources.config.gcpBackendClient;
      if (!gcpBackend || status !== "authenticated" || !user) {
        throw new Error("Not authenticated");
      }

      const { error } = await gcpBackend
        .from("investor_profiles")
        .update({ privacy_settings: privacySettings })
        .eq("user_id", user.id);

      if (error) throw error;

      toast({
        title: "Privacy Settings Saved",
        description: "Your privacy preferences have been updated",
        status: "success",
        duration: 3000,
      });
    } catch (error: any) {
      console.error("Error saving privacy settings:", error);
      toast({
        title: "Error",
        description: "Failed to save privacy settings",
        status: "error",
        duration: 5000,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleBackToProfile = () => {
    navigate("/hushh-user-profile");
  };

  return {
    loading,
    saving,
    privacySettings,
    handleToggle,
    handleSave,
    handleBackToProfile,
  };
}
