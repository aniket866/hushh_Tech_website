import config from "../../resources/config/config";

export interface RegistrationStatus {
  isRegistered: boolean;
  hasHushhId: boolean;
  userData?: any;
}

/**
 * Check if a user has completed their profile registration.
 * Uses the GcpBackend client from config instead of hardcoded URLs/keys.
 * @param email - User's email to check registration status
 * @returns RegistrationStatus object indicating registration state
 */
export default async function checkRegistrationStatus(
  email: string
): Promise<RegistrationStatus> {
  try {
    // Use the configured GcpBackend client instead of hardcoded old project URL
    const { data, error } = await config.gcpBackendClient!
      .from("users")
      .select("*")
      .ilike("email", `%${email}%`);

    if (error) {
      console.error("Error checking registration status:", error.message);
      return { isRegistered: false, hasHushhId: false, userData: null };
    }

    if (data && data.length > 0) {
      const userData = data[0];
      const hasHushhId = !!(userData.hushh_id && userData.hushh_id.trim() !== "");

      return {
        isRegistered: hasHushhId,
        hasHushhId,
        userData,
      };
    }

    // User doesn't exist in database
    return { isRegistered: false, hasHushhId: false, userData: null };
  } catch (error) {
    console.error("Error checking registration status:", error);
    return { isRegistered: false, hasHushhId: false, userData: null };
  }
}
