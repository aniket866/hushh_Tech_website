import { createGcpServerClient } from "./shared/gcpServerClient.js";

const getServiceClient = () => {
  const gcpBackendUrl = process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME?.trim();
  const serviceRoleKey = process.env.GCP_SERVER_ACTOR_UID?.trim();

  if (!gcpBackendUrl || !serviceRoleKey) {
    throw new Error("GcpBackend server environment variables are missing");
  }

  return createGcpServerClient(gcpBackendUrl, serviceRoleKey);
};

export const isPublicProfileFieldVisible = (
  privacySettings,
  section,
  field
) => {
  if (!privacySettings || typeof privacySettings !== "object") {
    return true;
  }

  const sectionSettings = privacySettings?.[section];
  const fieldSetting = sectionSettings?.[field];

  if (fieldSetting == null) {
    return true;
  }

  if (typeof fieldSetting === "boolean") {
    return fieldSetting;
  }

  if (
    typeof fieldSetting === "object" &&
    typeof fieldSetting?.value === "boolean"
  ) {
    return fieldSetting.value;
  }

  return true;
};

export const maskPublicEmail = (email) => {
  if (!email || !email.includes("@")) {
    return null;
  }

  const [username, domain] = email.split("@");

  if (!username || !domain) {
    return null;
  }

  if (username.length <= 2) {
    return `${username.slice(0, 1)}***@${domain}`;
  }

  return `${username.slice(0, 1)}***${username.slice(-1)}@${domain}`;
};

export const buildPublicInvestorProfilePayload = (
  profileRow,
  onboardingRow = null
) => {
  const privacySettings = profileRow?.privacy_settings || {};
  const isConfirmed = Boolean(profileRow?.user_confirmed);
  const investorProfile =
    isConfirmed && profileRow?.investor_profile && typeof profileRow.investor_profile === "object"
      ? Object.fromEntries(
          Object.entries(profileRow.investor_profile).filter(([fieldName]) =>
            isPublicProfileFieldVisible(
              privacySettings,
              "investor_profile",
              fieldName
            )
          )
        )
      : null;

  const filteredOnboardingData = isConfirmed
    ? {
        account_type: isPublicProfileFieldVisible(
          privacySettings,
          "onboarding_data",
          "account_type"
        )
          ? onboardingRow?.account_type || null
          : null,
        selected_fund: isPublicProfileFieldVisible(
          privacySettings,
          "onboarding_data",
          "selected_fund"
        )
          ? onboardingRow?.selected_fund || null
          : null,
        citizenship_country: isPublicProfileFieldVisible(
          privacySettings,
          "onboarding_data",
          "citizenship_country"
        )
          ? onboardingRow?.citizenship_country || null
          : null,
        residence_country: isPublicProfileFieldVisible(
          privacySettings,
          "onboarding_data",
          "residence_country"
        )
          ? onboardingRow?.residence_country || null
          : null,
      }
    : null;

  const onboardingData =
    filteredOnboardingData &&
    Object.values(filteredOnboardingData).some((value) => value !== null)
      ? filteredOnboardingData
      : null;

  return {
    slug: profileRow.slug,
    profile_url: `https://hushhtech.com/investor/${profileRow.slug}`,
    is_confirmed: isConfirmed,
    basic_info: {
      name: isPublicProfileFieldVisible(privacySettings, "basic_info", "name")
        ? profileRow.name?.trim() || "Public Investor"
        : "Public Investor",
      email: isPublicProfileFieldVisible(privacySettings, "basic_info", "email")
        ? maskPublicEmail(profileRow.email)
        : null,
      age: isPublicProfileFieldVisible(privacySettings, "basic_info", "age")
        ? profileRow.age ?? null
        : null,
      organisation: isPublicProfileFieldVisible(
        privacySettings,
        "basic_info",
        "organisation"
      )
        ? profileRow.organisation?.trim() || null
        : null,
    },
    investor_profile:
      investorProfile && Object.keys(investorProfile).length > 0
        ? investorProfile
        : null,
    onboarding_data: onboardingData,
    shadow_profile: isConfirmed ? profileRow.shadow_profile || null : null,
  };
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const slug =
    typeof req.query?.slug === "string" ? req.query.slug.trim() : "";

  if (!slug) {
    return res.status(400).json({ error: "Missing required slug" });
  }

  try {
    const gcpBackend = getServiceClient();
    const { data: profileRow, error: profileError } = await gcpBackend
      .from("investor_profiles")
      .select(
        "slug,user_id,name,email,age,organisation,is_public,user_confirmed,privacy_settings,investor_profile,shadow_profile"
      )
      .eq("slug", slug)
      .eq("is_public", true)
      .maybeSingle();

    if (profileError) {
      throw new Error(profileError.message);
    }

    if (!profileRow) {
      return res.status(404).json({ error: "Profile not found or is private" });
    }

    const { data: onboardingRow, error: onboardingError } = await gcpBackend
      .from("onboarding_data")
      .select(
        "account_type,selected_fund,citizenship_country,residence_country"
      )
      .eq("user_id", profileRow.user_id)
      .maybeSingle();

    if (onboardingError && onboardingError.code !== "PGRST116") {
      throw new Error(onboardingError.message);
    }

    res.setHeader("Cache-Control", "no-store");
    return res
      .status(200)
      .json(buildPublicInvestorProfilePayload(profileRow, onboardingRow));
  } catch (error) {
    console.error("public-investor-profile route error:", error);
    return res.status(500).json({
      error: "Failed to load public investor profile",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
