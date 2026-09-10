/** Optional UAT page traffic only; never use this to gate identity or consent. */
export function isUatNdaPage(
  pathname = typeof window === 'undefined' ? '' : window.location.pathname,
  hostname = typeof window === 'undefined' ? '' : window.location.hostname,
): boolean {
  return hostname === 'uat.hushhtech.com' && /^\/sign-nda\/*$/i.test(pathname);
}
