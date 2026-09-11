/** UAT's stock gateway and optional first-party collector are not enabled.
 * This is a presentation/telemetry policy, never an identity or access gate.
 * Other hosts retain their existing behavior.
 */
export function isUatWebsite(
  hostname = typeof window === 'undefined' ? '' : window.location.hostname,
): boolean {
  return hostname === 'uat.hushhtech.com';
}
