import { updateOwnHushhProfile } from "./hushhProfileApi";
import type { HushhProfileSeed } from "../../types/hushhProfile";
import { UserPreferenceProfile } from "../../types/preferences";

export interface SavePreferencesResult {
  success: boolean;
  error?: string;
}

export default async function savePreferences(
  preferences: UserPreferenceProfile,
  seed?: HushhProfileSeed
): Promise<SavePreferencesResult> {
  try {
    await updateOwnHushhProfile({
      profile: preferences,
      ...(seed ? { name: seed.name || null, organisation: seed.organisation || null } : {}),
    });
  } catch (error) {
    console.error("Failed to save Hushh profile:", error);
    return { success: false, error: error instanceof Error ? error.message : "Profile data is temporarily unavailable." };
  }

  return { success: true };
}
