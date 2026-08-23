/**
 * Email Utilities — Apple Private Relay Detection & Resolution
 * 
 * Apple's "Hide My Email" gives users a relay address like:
 * abc123@privaterelay.appleid.com
 * 
 * This utility helps detect and handle these relay addresses
 * across the app (NDA, notifications, profile, etc.)
 */

/** Check if an email is an Apple Private Relay address */
export const isPrivateRelayEmail = (email?: string | null): boolean =>
  !!email?.toLowerCase().includes('@privaterelay.appleid.com');

/**
 * Get the best available email for a GcpBackend user.
 * Priority: user_metadata.real_email > user.email
 */
export const getEffectiveEmail = (user: {
  email?: string | null;
  user_metadata?: Record<string, unknown>;
}): string => {
  const realEmail = user?.user_metadata?.real_email as string | undefined;
  if (realEmail && !isPrivateRelayEmail(realEmail)) return realEmail;
  return user?.email || '';
};

/**
 * Check if the email prefix is a garbage hash (Apple relay style).
 * Apple relay emails have random prefixes like "dxkf83jd" — not real names.
 */
export const isGarbageEmailPrefix = (email?: string | null): boolean => {
  if (!email) return false;
  const prefix = email.split('@')[0] || '';
  // Apple relay prefixes are random alphanumeric, no spaces/dots
  // Real names have dots, underscores, or are recognizable words
  const looksRandom = /^[a-z0-9]{6,}$/i.test(prefix) && !/[._-]/.test(prefix);
  return isPrivateRelayEmail(email) || looksRandom;
};
