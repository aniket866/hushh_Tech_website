import { getOwnHushhProfile } from "./hushhProfileApi";
import { PreferenceSeedInput, UserPreferenceProfile } from "../../types/preferences";

export interface UserPreferencesRecord {
  preferences: UserPreferenceProfile;
  user_seed: PreferenceSeedInput | null;
}

export default async function fetchPreferences(): Promise<UserPreferenceProfile | null> {
  const record = await fetchPreferencesWithSeed();
  return record?.preferences || null;
}

export async function fetchPreferencesWithSeed(): Promise<UserPreferencesRecord | null> {
  const profile = await getOwnHushhProfile();
  if (!profile?.profile) return null;

  const preferences = profile.profile;
  const user_seed: PreferenceSeedInput = {
    name: profile.name || "",
    email: profile.email || "",
    age: profile.age || 0,
    phone_country_code: profile.phone_country_code || "",
    phone_number: profile.phone_number || "",
    organisation: profile.organisation || null,
  };

  return {
    preferences,
    user_seed,
  };
}
