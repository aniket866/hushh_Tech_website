import enrichPreferences from "./enrichPreferences";
import fetchPreferences, { fetchPreferencesWithSeed } from "./fetchPreferences";
import savePreferences from "./savePreferences";
import { getOwnHushhProfile, getPublicHushhProfile, updateOwnHushhProfile } from "./hushhProfileApi";

const preferencesService = {
  enrichPreferences,
  fetchPreferences,
  fetchPreferencesWithSeed,
  getOwnHushhProfile,
  getPublicHushhProfile,
  updateOwnHushhProfile,
  savePreferences,
};

export default preferencesService;
export {
  enrichPreferences,
  fetchPreferences,
  fetchPreferencesWithSeed,
  getOwnHushhProfile,
  getPublicHushhProfile,
  updateOwnHushhProfile,
  savePreferences,
};
