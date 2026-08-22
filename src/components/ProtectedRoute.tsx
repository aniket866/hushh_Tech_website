import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import config from '../resources/config/config';
import {
  CANONICAL_ONBOARDING_ROUTES,
  FINANCIAL_LINK_ROUTE,
  getCanonicalOnboardingRoute,
  getOnboardingDisplayMeta,
  isLocalOnboardingPreview,
  normalizeFinancialLinkStatus,
  type CanonicalOnboardingRoute,
} from '../services/onboarding/flow';
import { useAuthSession } from '../auth/AuthSessionProvider';
import { buildLoginRedirectPath } from '../auth/routePolicy';
import { fetchResolvedOnboardingProgress } from '../services/onboarding/progress';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const BOOT_TIMEOUT_MS = 8000;

/**
 * sessionStorage flash key consumed by step pages to render a one-time
 * banner explaining that the user was bumped back from a step they tried
 * to jump to. Mirrors the InvestorAccessRoute flash convention.
 */
export const STEP_SKIP_FLASH_KEY = "hushh:step_skip_flash";

const setStepSkipFlash = (attemptedStep: number, redirectedToStep: number) => {
  try {
    sessionStorage.setItem(
      STEP_SKIP_FLASH_KEY,
      JSON.stringify({ attemptedStep, redirectedToStep }),
    );
  } catch {
    // sessionStorage disabled — flash gets dropped, redirect still works.
  }
};

export function consumeStepSkipFlash(): { attemptedStep: number; redirectedToStep: number } | null {
  try {
    const value = sessionStorage.getItem(STEP_SKIP_FLASH_KEY);
    if (!value) return null;
    sessionStorage.removeItem(STEP_SKIP_FLASH_KEY);
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, status } = useAuthSession();
  const isDevOnboardingPreview = isLocalOnboardingPreview(location.pathname, location.search);
  const userId = session?.user?.id;
  const authCheckKey = [
    status,
    userId ?? '',
    location.pathname,
    location.search,
    location.hash,
  ].join('|');
  const [isLoading, setIsLoading] = useState(true);
  const [authorizedCheckKey, setAuthorizedCheckKey] = useState<string | null>(null);
  const isAuthorized =
    isDevOnboardingPreview ||
    (status === 'authenticated' && authorizedCheckKey === authCheckKey);
  const bootTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Boot timeout safety net — if isLoading stays true for >8 seconds
  // (e.g., auth status stuck at 'booting'), redirect to login instead
  // of showing an infinite spinner. With the AuthSessionProvider fix
  // (instant boot from localStorage), this should rarely trigger.
  useEffect(() => {
    if (isLoading && !isDevOnboardingPreview) {
      bootTimeoutRef.current = setTimeout(() => {
        console.warn(
          '[ProtectedRoute] Boot timeout reached (8s). Redirecting to login.'
        );
        setIsLoading(false);
        navigate(
          buildLoginRedirectPath(location.pathname, location.search, location.hash),
          { replace: true }
        );
      }, BOOT_TIMEOUT_MS);
    } else if (bootTimeoutRef.current) {
      clearTimeout(bootTimeoutRef.current);
      bootTimeoutRef.current = null;
    }

    return () => {
      if (bootTimeoutRef.current) {
        clearTimeout(bootTimeoutRef.current);
        bootTimeoutRef.current = null;
      }
    };
  }, [isDevOnboardingPreview, isLoading, location.hash, location.pathname, location.search, navigate]);

  useEffect(() => {
    let isCurrentCheck = true;

    const redirectToLogin = () => {
      navigate(
        buildLoginRedirectPath(location.pathname, location.search, location.hash),
        { replace: true }
      );
    };

    const checkAuthAndOnboarding = async () => {
      let shouldSettleLoading = true;
      setIsLoading(true);
      setAuthorizedCheckKey(null);

      try {
        if (isDevOnboardingPreview) {
          setIsLoading(false);
          return;
        }

        if (status === 'booting') {
          shouldSettleLoading = false;
          return;
        }

        if (!config.gcpBackendClient) {
          redirectToLogin();
          return;
        }

        if (!userId) {
          redirectToLogin();
          return;
        }

        const onboardingData = await fetchResolvedOnboardingProgress(
          config.gcpBackendClient,
          userId
        );

        if (!isCurrentCheck) {
          return;
        }

        const isOnOnboardingPage = location.pathname.startsWith('/onboarding/');
        const isOnFinancialLinkPage = location.pathname === FINANCIAL_LINK_ROUTE;
        const isInvestorProfileAlias = location.pathname === '/investor-profile';
        const financialLinkStatus = normalizeFinancialLinkStatus(
          onboardingData?.financial_link_status
        );

        if (!onboardingData || !onboardingData.is_completed) {
          if (
            !isOnOnboardingPage &&
            !(isInvestorProfileAlias && financialLinkStatus !== 'pending')
          ) {
            navigate(FINANCIAL_LINK_ROUTE, { replace: true });
            return;
          }

          if (!isOnFinancialLinkPage && financialLinkStatus === 'pending') {
            navigate(FINANCIAL_LINK_ROUTE, { replace: true });
            return;
          }

          // PD-4 (step-skip prevention): if the user URL-pastes a step
          // further ahead than their current_step, bounce them back to
          // the step they should actually be on. The next page picks up
          // a session flash explaining what happened.
          const isCanonicalStep = (CANONICAL_ONBOARDING_ROUTES as readonly string[])
            .includes(location.pathname);
          if (isCanonicalStep) {
            const attemptedStep = getOnboardingDisplayMeta(
              location.pathname as CanonicalOnboardingRoute,
            ).displayStep;
            const canonicalCurrentRoute = getCanonicalOnboardingRoute(
              onboardingData?.current_step || 1,
            );
            const currentStepNumber = getOnboardingDisplayMeta(canonicalCurrentRoute)
              .displayStep;
            // Allow up to currentStep + 1 so the natural Next-button
            // navigation never trips this guard.
            if (attemptedStep > currentStepNumber + 1) {
              setStepSkipFlash(attemptedStep, currentStepNumber);
              navigate(canonicalCurrentRoute, { replace: true });
              return;
            }
          }
        }

        console.log('[ProtectedRoute] Authorization check passed');
        setAuthorizedCheckKey(authCheckKey);
      } catch (error) {
        if (!isCurrentCheck) {
          return;
        }

        console.error("Error checking auth:", error);
        redirectToLogin();
      } finally {
        if (isCurrentCheck && shouldSettleLoading) {
          setIsLoading(false);
        }
      }
    };

    checkAuthAndOnboarding();

    return () => {
      isCurrentCheck = false;
    };
  }, [authCheckKey, isDevOnboardingPreview, location.hash, location.pathname, location.search, navigate, status, userId]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-400 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthorized) return null;

  return <>{children}</>;
};

export default ProtectedRoute;
