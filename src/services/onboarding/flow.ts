export const FINANCIAL_LINK_ROUTE = '/onboarding/financial-link' as const;
export const FINANCIAL_LINK_REVIEW_ROUTE = `${FINANCIAL_LINK_ROUTE}?mode=review` as const;

export type FinancialLinkStatus = 'pending' | 'completed' | 'skipped';
const LOCAL_ONBOARDING_PREVIEW_PARAM = 'preview';

const TOTAL_VISIBLE_ONBOARDING_STEPS = 6;

const CANONICAL_STEP_ROUTE_BY_DISPLAY_STEP = {
  1: '/onboarding/step-1',
  2: '/onboarding/step-2',
  3: '/onboarding/step-3',
  4: '/onboarding/step-4',
  5: '/onboarding/step-5',
  6: '/onboarding/step-6',
} as const;

export type CanonicalOnboardingRoute =
  (typeof CANONICAL_STEP_ROUTE_BY_DISPLAY_STEP)[keyof typeof CANONICAL_STEP_ROUTE_BY_DISPLAY_STEP];

export type CanonicalIncompleteOnboardingRoute =
  | typeof FINANCIAL_LINK_ROUTE
  | CanonicalOnboardingRoute;

export const CANONICAL_ONBOARDING_ROUTES = Object.values(
  CANONICAL_STEP_ROUTE_BY_DISPLAY_STEP
) as CanonicalOnboardingRoute[];

const DISPLAY_STEP_BY_ROUTE: Record<CanonicalOnboardingRoute, number> = {
  '/onboarding/step-1': 1,
  '/onboarding/step-2': 2,
  '/onboarding/step-3': 3,
  '/onboarding/step-4': 4,
  '/onboarding/step-5': 5,
  '/onboarding/step-6': 6,
};

/**
 * Maps raw GcpBackend `current_step` values to canonical routes.
 * Multiple raw values can map to the same route (for backward compat).
 *
 * After combining old step-3 (country) + old step-6 (address) into new step-3:
 *   raw 4 → step-3 (combined country + address)
 *   raw 8 → step-3 (old address step now folded into step-3)
 */
const RAW_STEP_TO_ROUTE: Record<number, CanonicalOnboardingRoute> = {
  1: '/onboarding/step-1',
  2: '/onboarding/step-2',
  3: '/onboarding/step-3',
  4: '/onboarding/step-3',
  5: '/onboarding/step-3',
  6: '/onboarding/step-3',
  7: '/onboarding/step-3',
  8: '/onboarding/step-3',  // old address step → now folded into combined step-3
  9: '/onboarding/step-3',
  10: '/onboarding/step-4',
  11: '/onboarding/step-4',
  // raw 12 is written by the investment step (step-4) on Continue → the user has
  // *completed* investment and is now at the review step (step-5). Mapping it to
  // step-5 (not step-4) keeps the skip-guard from bouncing review → payment back
  // to investment: payment (display 6) is then within currentStep(5) + 1.
  12: '/onboarding/step-5',
  13: '/onboarding/step-6',
};

export const getCanonicalOnboardingRoute = (currentStep: number): CanonicalOnboardingRoute => {
  const normalizedStep = Number.isFinite(currentStep) ? Math.trunc(currentStep) : 1;
  return RAW_STEP_TO_ROUTE[normalizedStep] || '/onboarding/step-1';
};

export const normalizeFinancialLinkStatus = (
  value: unknown,
  fallback: FinancialLinkStatus = 'pending'
): FinancialLinkStatus => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'skipped') {
    return normalized;
  }

  if (normalized === 'pending') {
    return 'pending';
  }

  return fallback;
};

export const resolveFinancialLinkStatus = (
  onboardingStatus: unknown,
  financialDataStatus?: unknown
): FinancialLinkStatus => {
  const normalizedOnboardingStatus = normalizeFinancialLinkStatus(onboardingStatus);
  if (normalizedOnboardingStatus !== 'pending') {
    return normalizedOnboardingStatus;
  }

  const normalizedFinancialStatus = String(financialDataStatus ?? '')
    .trim()
    .toLowerCase();

  if (normalizedFinancialStatus === 'complete' || normalizedFinancialStatus === 'partial') {
    return 'completed';
  }

  return 'pending';
};

export const hasClearedFinancialLink = (value: unknown): boolean =>
  normalizeFinancialLinkStatus(value) !== 'pending';

export const getCanonicalIncompleteOnboardingRoute = (): typeof FINANCIAL_LINK_ROUTE =>
  FINANCIAL_LINK_ROUTE;

export const isFinancialLinkReviewMode = (search: string): boolean => {
  const params = new URLSearchParams(search);
  return params.get('mode') === 'review';
};

export const isLocalOnboardingPreview = (
  pathname: string,
  search: string = ''
): boolean => {
  if (!import.meta.env.DEV) return false;
  if (!pathname.startsWith('/onboarding/')) return false;
  const params = new URLSearchParams(search);
  return params.get(LOCAL_ONBOARDING_PREVIEW_PARAM) === '1';
};

export const isCurrentLocalOnboardingPreview = (): boolean => (
  typeof window !== 'undefined' &&
  isLocalOnboardingPreview(window.location.pathname, window.location.search)
);

export const withLocalOnboardingPreview = (route: string): string => {
  if (!isCurrentLocalOnboardingPreview()) return route;

  const parsed = new URL(route, 'https://hushh.local');
  parsed.searchParams.set(LOCAL_ONBOARDING_PREVIEW_PARAM, '1');
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
};

// Edit-and-return: the Review screen (step-5) opens an earlier step to edit a
// single field by appending `?from=review`. The edited step reads this flag and,
// instead of marching forward through the wizard on Save/Back, returns straight
// to Review. Steps must ALSO avoid downgrading `current_step` while editing, or
// the ProtectedRoute skip-guard would bounce the return-to-Review navigation.
export const REVIEW_ROUTE = '/onboarding/step-5' as const;
const EDIT_RETURN_PARAM = 'from';
const EDIT_RETURN_VALUE = 'review';

export const isReturnToReview = (search: string): boolean =>
  new URLSearchParams(search).get(EDIT_RETURN_PARAM) === EDIT_RETURN_VALUE;

export const withReviewEdit = (route: string): string => {
  const parsed = new URL(route, 'https://hushh.local');
  parsed.searchParams.set(EDIT_RETURN_PARAM, EDIT_RETURN_VALUE);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
};

export const getFinancialLinkContinuationRoute = (
  currentStep: number
): CanonicalOnboardingRoute => {
  const normalizedStep = Number.isFinite(currentStep) ? Math.trunc(currentStep) : 1;
  return getCanonicalOnboardingRoute(normalizedStep > 1 ? normalizedStep : 1);
};

export const normalizeLegacyOnboardingRedirectTarget = (target: string): string => {
  try {
    const parsed = new URL(target, 'https://hushh.local');
    if (parsed.pathname.toLowerCase() === '/investor-profile') {
      return FINANCIAL_LINK_ROUTE;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return target;
  }
};

// Legacy URL aliases — old raw-numbered paths still resolve to the new canonical
// routes (URLs are now sequential step-1…step-6 matching the 6-step display).
const COMPATIBLE_ROUTE_ALIAS: Record<string, CanonicalOnboardingRoute> = {
  '/onboarding/step-7': '/onboarding/step-4',
  '/onboarding/step-8': '/onboarding/step-5',
  '/onboarding/step-9': '/onboarding/step-6',
};

const normalizeCompatibleOnboardingRoute = (route: string): CanonicalOnboardingRoute => {
  if (CANONICAL_ONBOARDING_ROUTES.includes(route as CanonicalOnboardingRoute)) {
    return route as CanonicalOnboardingRoute;
  }

  if (COMPATIBLE_ROUTE_ALIAS[route]) {
    return COMPATIBLE_ROUTE_ALIAS[route];
  }

  return '/onboarding/step-1';
};

export const getOnboardingDisplayMeta = (
  routeOrStep: string | number
): { route: CanonicalOnboardingRoute; displayStep: number; totalSteps: number } => {
  const route =
    typeof routeOrStep === 'number'
      ? getCanonicalOnboardingRoute(routeOrStep)
      : normalizeCompatibleOnboardingRoute(routeOrStep);

  return {
    route,
    displayStep: DISPLAY_STEP_BY_ROUTE[route],
    totalSteps: TOTAL_VISIBLE_ONBOARDING_STEPS,
  };
};

export const getContinueOnboardingCta = (
  currentStep: number
): { route: CanonicalOnboardingRoute; text: string } => {
  const { route, displayStep } = getOnboardingDisplayMeta(currentStep);
  return {
    route,
    text: `Continue Onboarding (Step ${displayStep})`,
  };
};

export { TOTAL_VISIBLE_ONBOARDING_STEPS };
