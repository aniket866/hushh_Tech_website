import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useToast } from "@chakra-ui/react";
import resources from "../../resources/resources";
import { InvestorProfile } from "../../types/investorProfile";
import { useAuthSession } from "../../auth/AuthSessionProvider";
import { buildLoginRedirectPath } from "../../auth/routePolicy";

export interface InvestorProfileData {
  user_id: string;
  name: string;
  email: string;
  age: number;
  phone_country_code: string;
  phone_number: string;
  organisation: string | null;
  investor_profile: InvestorProfile;
  confirmed_at: string;
}

export interface ConfidencePill {
  label: string;
  color: string;
  bg: string;
  border: string;
}

export function pillForConfidence(confidence: number): ConfidencePill {
  if (confidence >= 0.8) {
    return { label: "HIGH", color: "#15803D", bg: "#F0FDF4", border: "#BBF7D0" };
  }
  if (confidence >= 0.5) {
    return { label: "MEDIUM", color: "#A16207", bg: "#FEFCE8", border: "#FEF08A" };
  }
  return { label: "LOW", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" };
}

export function useViewPreferencesLogic() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { id: routeUserId } = useParams();
  const { status, user } = useAuthSession();
  const [profileData, setProfileData] = useState<InvestorProfileData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const gcpBackend = resources.config.gcpBackendClient;
        if (!gcpBackend) {
          throw new Error("GcpBackend client not available");
        }

        if (status === "booting") {
          return;
        }

        // Use routeUserId if provided, otherwise use current user's id
        const userIdToFetch = routeUserId || user?.id;

        if (!userIdToFetch) {
          navigate(
            buildLoginRedirectPath(location.pathname, location.search, location.hash),
            { replace: true }
          );
          return;
        }

        // Fetch investor profile from GcpBackend
        const { data, error } = await gcpBackend
          .from("investor_profiles")
          .select("*")
          .eq("user_id", userIdToFetch)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          toast({
            title: "No Profile Found",
            description: "Create your investor profile first",
            status: "info",
            duration: 4000,
          });
          navigate("/hushh-user-profile");
          return;
        }

        setProfileData(data);
      } catch (error: any) {
        console.error("Error fetching profile:", error);
        toast({
          title: "Error",
          description: error.message || "Failed to load profile",
          status: "error",
          duration: 5000,
        });
        // Redirect to profile creation if no profile exists
        navigate("/hushh-user-profile");
      } finally {
        setLoading(false);
      }
    };

    void fetchProfile();
  }, [location.hash, location.pathname, location.search, navigate, routeUserId, status, toast, user?.id]);

  const profileUrl = profileData
    ? `https://hushhtech.com/investor/${profileData.user_id}`
    : "";

  const handleShareProfile = () => {
    if (profileUrl) {
      window.open(profileUrl, "_blank");
    }
  };

  const handleCopyLink = () => {
    if (profileUrl) {
      navigator.clipboard.writeText(profileUrl);
      toast({ title: "Copied", status: "success", duration: 1200, isClosable: false });
    }
  };

  const handleNavigateToProfile = () => {
    navigate("/hushh-user-profile");
  };

  return {
    loading,
    profileData,
    profileUrl,
    handleShareProfile,
    handleCopyLink,
    handleNavigateToProfile,
  };
}
