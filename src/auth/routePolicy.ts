import { DEFAULT_AUTH_REDIRECT, sanitizeInternalRedirect } from "../utils/security";
import { normalizeLegacyOnboardingRedirectTarget } from "../services/onboarding/flow";
import {
  HUSHH_RESEARCH_CALLBACK_PATH,
  HUSHH_RESEARCH_START_ROUTE,
  isHushhResearchAuthRoute,
} from "../services/hushhResearch/contracts";

export const GUEST_AUTH_ROUTE_PREFIXES = [
  "/login",
  "/signup",
  "/auth/callback",
  "/auth/hushh-research",
  "/sign-nda",
  "/document-viewer",
] as const;

export const PUBLIC_MARKETING_ROUTE_PREFIXES = [
  "/",
  "/metric",
  "/metrics",
  "/privacy-policy",
  "/privacy",
  "/terms",
  "/terms-of-service",
  "/risk-disclosures",
  "/faq",
  "/career-privacy-policy",
  "/carrer-privacy-policy",
  "/california-privacy-policy",
  "/eu-uk-jobs-privacy-policy",
  "/investor-guide",
  "/about",
  "/philosophy",
  "/services",
  "/career",
  "/careers",
  "/disclosures",
  "/support",
  "/community",
  "/contact",
  "/benefits",
  "/hushh-ai",
  "/kai",
  "/kai-india",
  "/studio",
] as const;

export const PUBLIC_MARKETING_EXACT_ROUTES = ["/profile"] as const;

export const HUSHH_RESEARCH_EXACT_ROUTES = [
  "/",
  "/profile",
  "/signed-out",
  HUSHH_RESEARCH_START_ROUTE,
  HUSHH_RESEARCH_CALLBACK_PATH,
] as const;

export const AUTHENTICATED_ACCOUNT_ROUTE_PREFIXES = [
  "/delete-account",
  "/hushh-user-profile",
  "/onboarding",
  "/user-registration",
  "/investor-profile",
  "/user-profile",
  "/your-profile",
  "/nda-form",
] as const;

export const PUBLIC_SHARED_PROFILE_ROUTE_PREFIXES = [
  "/investor/",
  "/hushhid/",
] as const;

function normalizePathname(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }

  return trimmed.toLowerCase();
}

function matchesRoute(pathname: string, route: string): boolean {
  const normalizedPath = normalizePathname(pathname);
  const normalizedRoute = normalizePathname(route);

  if (normalizedRoute === "/") {
    return normalizedPath === "/";
  }

  return (
    normalizedPath === normalizedRoute ||
    normalizedPath.startsWith(`${normalizedRoute}/`)
  );
}

function matchesSharedPrefix(pathname: string, routePrefix: string): boolean {
  return normalizePathname(pathname).startsWith(normalizePathname(routePrefix));
}

function decodeReportId(segment: string): string | null {
  let decoded = segment;

  try {
    // React Router and the browser can decode at different layers. Decode a
    // bounded number of times so an encoded slash cannot become a second
    // route segment after this policy check.
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return null;
  }

  return /^[a-z0-9][a-z0-9._~-]{0,127}$/i.test(decoded) &&
    decoded !== "." &&
    decoded !== ".."
    ? decoded
    : null;
}

function isHushhResearchReportRoute(pathname: string): boolean {
  const normalizedPath = normalizePathname(pathname);
  const match = normalizedPath.match(/^\/reports\/([^/]+)\/?$/);
  return Boolean(match?.[1] && decodeReportId(match[1]));
}

export function isGuestAuthRoute(pathname: string): boolean {
  return GUEST_AUTH_ROUTE_PREFIXES.some((route) => matchesRoute(pathname, route));
}

export function isPublicMarketingRoute(pathname: string): boolean {
  const normalizedPath = normalizePathname(pathname);
  return (
    PUBLIC_MARKETING_EXACT_ROUTES.some(
      (route) => normalizePathname(route) === normalizedPath,
    ) ||
    PUBLIC_MARKETING_ROUTE_PREFIXES.some((route) =>
      matchesRoute(pathname, route)
    )
  );
}

export function isAuthenticatedAccountRoute(pathname: string): boolean {
  return AUTHENTICATED_ACCOUNT_ROUTE_PREFIXES.some((route) =>
    matchesRoute(pathname, route)
  );
}

export function isPublicSharedProfileRoute(pathname: string): boolean {
  return PUBLIC_SHARED_PROFILE_ROUTE_PREFIXES.some((routePrefix) =>
    matchesSharedPrefix(pathname, routePrefix)
  );
}

export function canGuestAccessRoute(pathname: string): boolean {
  return (
    isGuestAuthRoute(pathname) ||
    isPublicMarketingRoute(pathname) ||
    isPublicSharedProfileRoute(pathname)
  );
}

export function canHushhResearchAccessRoute(pathname: string): boolean {
  const normalizedPath = normalizePathname(pathname);
  return (
    isHushhResearchAuthRoute(pathname) ||
    HUSHH_RESEARCH_EXACT_ROUTES.some(
      (route) => normalizePathname(route) === normalizedPath,
    ) ||
    isHushhResearchReportRoute(pathname)
  );
}

export function buildLoginRedirectPath(
  pathname: string,
  search = "",
  hash = "",
  fallback = DEFAULT_AUTH_REDIRECT
): string {
  const redirectTarget = normalizeLegacyOnboardingRedirectTarget(
    sanitizeInternalRedirect(`${pathname || "/"}${search}${hash}`, fallback)
  );

  return `/login?redirect=${encodeURIComponent(redirectTarget)}`;
}
