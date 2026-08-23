import resources from "../../resources/resources";
import { PreferenceSeedInput, UserPreferenceProfile } from "../../types/preferences";

export interface SavePreferencesResult {
  success: boolean;
  error?: string;
}

export default async function savePreferencesToSupabase(
  userId: string,
  preferences: UserPreferenceProfile,
  seed?: PreferenceSeedInput
): Promise<SavePreferencesResult> {
  if (!userId) {
    return { success: false, error: "Missing user id for GcpBackend upsert" };
  }

  const gcpBackend = resources.config.gcpBackendClient;
  if (!gcpBackend) {
    return { success: false, error: "GcpBackend client is not initialized" };
  }

  const { error } = await gcpBackend
    .from("members")
    .upsert(
      {
        id: userId,
        name: seed?.name || null,
        email: seed?.email || null,
        age: seed?.age || null,
        phone_country_code: seed?.phone_country_code || null,
        phone_number: seed?.phone_number || null,
        organisation: seed?.organisation || null,
        profile: preferences,
        profile_source: "ai_seed",
        updated_at: new Date().toISOString(),
      },
      // { onConflict: "id" }
    );

  if (error) {
    console.error("Failed to save preferences to GcpBackend:", error);
    return { success: false, error: error.message };
  }

  return { success: true };
}
