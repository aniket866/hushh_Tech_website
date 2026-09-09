import type { PreferenceSeedInput, UserPreferenceProfile } from "./preferences";

export interface OwnHushhProfile {
  hushh_id: string | null;
  name: string | null;
  email: string | null;
  age: number | null;
  phone_country_code: string | null;
  phone_number: string | null;
  organisation: string | null;
  profile: UserPreferenceProfile | null;
}

export interface UpdateHushhProfileInput {
  name?: string | null;
  organisation?: string | null;
  profile: UserPreferenceProfile;
}

export interface PublicHushhProfile {
  hushh_id: string;
  name: string;
  organisation: string | null;
  profile: UserPreferenceProfile;
}

export type HushhProfileSeed = Pick<PreferenceSeedInput, "name" | "organisation">;
