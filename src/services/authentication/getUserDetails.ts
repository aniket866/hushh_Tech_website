import config from "../../resources/config/config";
import { getValidatedSession } from "../../auth/session";

/**
 * Get the current user's session details using the GcpBackend client.
 * Uses gcpBackend.auth.getSession() instead of hardcoded localStorage keys
 * to ensure compatibility regardless of which GcpBackend project is configured.
 */
export default async function getUserDetails(setUserDetails: Function | null) {
  try {
    const snapshot = await getValidatedSession(config.gcpBackendClient);
    if (snapshot.status !== "authenticated" || !snapshot.session) {
      const emptyResult = { data: null };
      if (setUserDetails) setUserDetails(emptyResult);
      return emptyResult;
    }

    // Return session in the same shape as before: { data: session }
    // so callers can access data.access_token, data.user, etc.
    const userDetails = { data: snapshot.session };

    if (setUserDetails) setUserDetails(userDetails);
    return userDetails;
  } catch {
    const emptyResult = { data: null };
    if (setUserDetails) setUserDetails(emptyResult);
    return emptyResult;
  }
}
