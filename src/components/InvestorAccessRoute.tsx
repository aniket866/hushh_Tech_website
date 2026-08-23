/**
 * InvestorAccessRoute — wraps a protected route AND enforces the Stripe
 * payment / investor verification gate. The Hushh Fund's product rule is
 * that Meet CEO and the investor profile dashboard are only reachable once
 * the user has paid (and not been refunded / rejected).
 *
 * Layers on top of ProtectedRoute's auth check by reading the onboarding row
 * via fetchResolvedOnboardingProgress and routing per the access state
 * machine in `services/investorAccess/state.ts`.
 */
import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import config from "../resources/config/config";
import { useAuthSession } from "../auth/AuthSessionProvider";
import { buildLoginRedirectPath } from "../auth/routePolicy";
import { fetchResolvedOnboardingProgress } from "../services/onboarding/progress";
import {
  decideInvestorAccessRoute,
  getInvestorAccessState,
  type InvestorAccessRedirectReason,
} from "../services/investorAccess/state";

interface InvestorAccessRouteProps {
  children: React.ReactNode;
}

const BOOT_TIMEOUT_MS = 8000;

/**
 * Shared sessionStorage key used by step-9 / access-denied / fund-payment to
 * surface a one-time banner explaining why the user was redirected.
 */
export const INVESTOR_ACCESS_FLASH_KEY = "hushh:investor_access_flash";

function setAccessFlash(reason: InvestorAccessRedirectReason) {
  try {
    sessionStorage.setItem(INVESTOR_ACCESS_FLASH_KEY, reason);
  } catch {
    // sessionStorage may be unavailable in private browsing — banner gets
    // skipped, redirect still works.
  }
}

export function consumeInvestorAccessFlash(): InvestorAccessRedirectReason | null {
  try {
    const value = sessionStorage.getItem(INVESTOR_ACCESS_FLASH_KEY);
    if (!value) return null;
    sessionStorage.removeItem(INVESTOR_ACCESS_FLASH_KEY);
    return value as InvestorAccessRedirectReason;
  } catch {
    return null;
  }
}

const InvestorAccessRoute: React.FC<InvestorAccessRouteProps> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, status } = useAuthSession();
  const userId = session?.user?.id;
  const checkKey = [
    status,
    userId ?? "",
    location.pathname,
    location.search,
    location.hash,
  ].join("|");

  const [isLoading, setIsLoading] = useState(true);
  const [authorizedCheckKey, setAuthorizedCheckKey] = useState<string | null>(null);
  const isAuthorized =
    status === "authenticated" && authorizedCheckKey === checkKey;
  const bootTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isLoading) {
      bootTimeoutRef.current = setTimeout(() => {
        console.warn(
          "[InvestorAccessRoute] Boot timeout reached (8s). Redirecting to login."
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
  }, [isLoading, location.hash, location.pathname, location.search, navigate]);

  useEffect(() => {
    let isCurrentCheck = true;

    const redirectToLogin = () => {
      navigate(
        buildLoginRedirectPath(location.pathname, location.search, location.hash),
        { replace: true }
      );
    };

    const run = async () => {
      let shouldSettleLoading = true;
      setIsLoading(true);
      setAuthorizedCheckKey(null);

      try {
        if (status === "booting") {
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

        if (!isCurrentCheck) return;

        const accessState = getInvestorAccessState(onboardingData);
        const decision = decideInvestorAccessRoute(accessState);

        if (!decision.allow) {
          if (decision.reason) {
            setAccessFlash(decision.reason);
          }
          if (decision.redirectTo && decision.redirectTo !== location.pathname) {
            navigate(decision.redirectTo, { replace: true });
            return;
          }
          // Edge case: redirectTo equals the current pathname (shouldn't
          // happen because this wrapper only fronts paid-only routes), but
          // guard against an infinite-redirect loop.
          return;
        }

        setAuthorizedCheckKey(checkKey);
      } catch (error) {
        if (!isCurrentCheck) return;
        console.error("[InvestorAccessRoute] Auth/access check failed", error);
        redirectToLogin();
      } finally {
        if (isCurrentCheck && shouldSettleLoading) {
          setIsLoading(false);
        }
      }
    };

    void run();

    return () => {
      isCurrentCheck = false;
    };
  }, [checkKey, location.hash, location.pathname, location.search, navigate, status, userId]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-400 mx-auto" />
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthorized) return null;
  return <>{children}</>;
};

export default InvestorAccessRoute;
