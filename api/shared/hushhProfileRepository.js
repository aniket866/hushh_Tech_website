export const PROFILE_DATA_CONTRACT_NOT_READY = "PROFILE_DATA_CONTRACT_NOT_READY";
export const PUBLIC_HUSHH_ID_CONTRACT_NOT_READY = "PUBLIC_HUSHH_ID_CONTRACT_NOT_READY";

function contractError(code) {
  const message = code === PROFILE_DATA_CONTRACT_NOT_READY
    ? "Profile data is temporarily unavailable."
    : "This public profile is temporarily unavailable.";
  return Object.assign(new Error(message), { status: 503, code });
}

export async function getOwnProfile(_firebaseUid) {
  throw contractError(PROFILE_DATA_CONTRACT_NOT_READY);
}

export async function updateOwnProfile(_firebaseUid, _payload) {
  throw contractError(PROFILE_DATA_CONTRACT_NOT_READY);
}

export async function getPublicProfile(_hushhId) {
  throw contractError(PUBLIC_HUSHH_ID_CONTRACT_NOT_READY);
}
