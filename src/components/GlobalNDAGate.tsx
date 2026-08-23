/**
 * GlobalNDAGate Component
 * 
 * GLOBAL NDA ENFORCEMENT - Acts as a universal key for the entire website.
 * 
 * How it works:
 * - If user is NOT authenticated → Allow access (they'll see public marketing pages)
 * - If user IS authenticated → Check NDA status
 *   - If NDA signed → Allow access to all routes
 *   - If NDA NOT signed → Redirect to /sign-nda (only allow minimal auth routes)
 * 
 * This ensures NO authenticated user can access ANY content without signing the NDA first.
 */

import React, { useEffect, useRef, useState, ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Box, Spinner, VStack, Text } from '@chakra-ui/react';
import { checkNDAStatus } from '../services/nda/ndaService';
import { useAuthSession } from '../auth/AuthSessionProvider';
import {
  buildLoginRedirectPath,
  canHushhResearchAccessRoute,
  canGuestAccessRoute,
  isAuthenticatedAccountRoute,
  isGuestAuthRoute,
  isPublicSharedProfileRoute,
} from '../auth/routePolicy';
import { isLocalOnboardingPreview } from '../services/onboarding/flow';
import {
  getHushhResearchCompatibilityMode,
  HushhResearchCompatibilityError,
} from '../services/hushhResearch/compatibility';
import { HUSHH_RESEARCH_SOURCE } from '../services/hushhResearch/contracts';
import { isHushhResearchAuthMode } from '../services/hushhResearch/firebaseAuth';

interface GlobalNDAGateProps {
  children: ReactNode;
}

function canResearchSessionAccessWithoutLegacyNda(
  pathname: string,
): boolean {
  return canHushhResearchAccessRoute(pathname);
}

const GlobalNDAGate: React.FC<GlobalNDAGateProps> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, status } = useAuthSession();
  const [isChecking, setIsChecking] = useState(true);
  const [hasSignedNDA, setHasSignedNDA] = useState<boolean | null>(null);
  const isResearchModeActive = isHushhResearchAuthMode();
  const isResearchSessionHint =
    session?.user?.app_metadata?.auth_source === HUSHH_RESEARCH_SOURCE;
  const isResearchBoundaryActive =
    isResearchModeActive || isResearchSessionHint;

  // Fallback timeout — if isChecking stays true for >8 seconds,
  // auto-resolve to prevent infinite "Verifying access..." spinner.
  // This handles edge cases where auth status gets stuck at 'booting'
  // (e.g., OAuth race condition, network hang on getUser()).
  const bootTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isChecking) {
      bootTimeoutRef.current = setTimeout(() => {
        if (isResearchBoundaryActive) {
          // Research sessions never receive optimistic NDA access. If the
          // refreshed session check stalls, settle on the public surface only.
          setHasSignedNDA(false);
          setIsChecking(false);
          if (!canResearchSessionAccessWithoutLegacyNda(location.pathname)) {
            navigate('/', { replace: true });
          }
          return;
        }

        console.warn(
          '[GlobalNDAGate] Boot timeout reached (8s). Forcing access check to resolve.'
        );
        setIsChecking(false);
        // Allow access to public/guest routes; authenticated-only routes
        // will be caught by ProtectedRoute downstream.
        setHasSignedNDA(canGuestAccessRoute(location.pathname));
      }, 8000);
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
  }, [isChecking, isResearchBoundaryActive, location.pathname, navigate]);

  useEffect(() => {
    let cancelled = false;

    const checkNDA = async () => {
      const pathname = location.pathname;
      const isDevOnboardingPreview = isLocalOnboardingPreview(pathname, location.search);

      // Research mode is a separate identity and product-data boundary. It
      // can render only explicitly public/Research-auth routes and must never
      // mount the legacy OAuth callback or consult the legacy NDA backend.
      if (isResearchBoundaryActive) {
        const canAccess = canResearchSessionAccessWithoutLegacyNda(pathname);
        if (!cancelled) {
          setIsChecking(false);
          setHasSignedNDA(canAccess);
          if (!canAccess) {
            navigate('/', { replace: true });
          }
        }
        return;
      }

      if (isDevOnboardingPreview) {
        if (!cancelled) {
          setIsChecking(false);
          setHasSignedNDA(true);
        }
        return;
      }

      // Always allow auth-related routes (login, signup, sign-nda, callback)
      if (isGuestAuthRoute(pathname)) {
        if (!cancelled) {
          setIsChecking(false);
          setHasSignedNDA(true);
        }
        return;
      }

      // Always allow public profile routes (shared investor profiles)
      // These must be accessible by ANYONE — authenticated or not, NDA or not
      if (isPublicSharedProfileRoute(pathname)) {
        if (!cancelled) {
          setIsChecking(false);
          setHasSignedNDA(true);
        }
        return;
      }

      // If no session (not logged in), allow access to public pages
      if (status === 'booting') {
        if (!cancelled) {
          setIsChecking(true);
          setHasSignedNDA(null);
        }
        return;
      }

      if (!session?.user?.id || status !== 'authenticated') {
        if (isAuthenticatedAccountRoute(pathname)) {
          navigate(
            buildLoginRedirectPath(
              location.pathname,
              location.search,
              location.hash
            ),
            { replace: true }
          );
          return;
        }

        // Allow public marketing and guest-accessible routes for non-authenticated users
        if (!cancelled) {
          setIsChecking(false);
          setHasSignedNDA(canGuestAccessRoute(pathname));
        }
        return;
      }

      if (!cancelled) {
        setIsChecking(true);
        setHasSignedNDA(null);
      }

      // Resolve the refreshed Research session before consulting the legacy
      // NDA backend. LINK_REQUIRED and invalidated Research sessions are also
      // handled here so they cannot fall through to GcpBackend.
      try {
        const compatibilityMode = await getHushhResearchCompatibilityMode();
        if (compatibilityMode === 'research') {
          if (!cancelled) {
            setHasSignedNDA(false);
            setIsChecking(false);
            if (!canResearchSessionAccessWithoutLegacyNda(pathname)) {
              navigate('/', { replace: true });
            }
          }
          return;
        }
      } catch (error) {
        if (error instanceof HushhResearchCompatibilityError) {
          if (!cancelled) {
            setHasSignedNDA(false);
            setIsChecking(false);
            if (!canResearchSessionAccessWithoutLegacyNda(pathname)) {
              navigate('/', { replace: true });
            }
          }
          return;
        }
        throw error;
      }

      // USER IS AUTHENTICATED - Check NDA status (with 5s timeout)
      try {
        const NDA_CHECK_TIMEOUT_MS = 5000;
        const ndaResult = await Promise.race([
          checkNDAStatus(session.user.id),
          new Promise<null>((_, reject) =>
            setTimeout(
              () => reject(new Error('NDA check timed out')),
              NDA_CHECK_TIMEOUT_MS
            )
          ),
        ]);

        if (cancelled) {
          return;
        }

        if (!ndaResult) {
          // Timeout fallback — allow access optimistically.
          // The NDA status will be rechecked on next navigation.
          console.warn('[GlobalNDAGate] NDA check returned null, allowing access optimistically.');
          setHasSignedNDA(true);
          return;
        }

        setHasSignedNDA(ndaResult.hasSignedNda);

        // If NDA not signed, redirect to NDA page
        if (!ndaResult.hasSignedNda) {
          // Store the intended destination for redirect after signing
          sessionStorage.setItem('nda_redirect_after', pathname);
          navigate('/sign-nda', { replace: true });
          return; // Stop execution here
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        // If the error is a timeout, allow access optimistically
        if (error instanceof Error && error.message === 'NDA check timed out') {
          console.warn('[GlobalNDAGate] NDA check timed out after 5s. Allowing access optimistically.');
          setHasSignedNDA(true);
          return;
        }

        console.error('Error checking NDA status:', error);
        // On non-timeout error, redirect to NDA page to be safe
        sessionStorage.setItem('nda_redirect_after', pathname);
        navigate('/sign-nda', { replace: true });
        return; // Stop execution here
      } finally {
        if (!cancelled) {
          setIsChecking(false);
        }
      }
    };

    void checkNDA();

    return () => {
      cancelled = true;
    };
  }, [isResearchBoundaryActive, location.hash, location.pathname, location.search, navigate, session?.user?.id, status]);

  // Show loading state while checking - Apple-style black/white design
  if (isChecking) {
    return (
      <Box
        minH="100dvh"
        display="flex"
        alignItems="center"
        justifyContent="center"
        bg="white"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <VStack spacing={4}>
          <Spinner
            thickness="3px"
            speed="0.65s"
            emptyColor="gray.200"
            color="black"
            size="xl"
            label="Verifying your access permissions"
          />
          <Text color="gray.600" fontSize="sm" fontWeight="medium">
            Verifying access...
          </Text>
        </VStack>
      </Box>
    );
  }

  // Security Check: Only render children if access is explicitly allowed
  // or it's a public/guest-accessible route.
  const canAccessWithoutNda = canGuestAccessRoute(location.pathname) ||
    isPublicSharedProfileRoute(location.pathname);
  const canAccess = isResearchBoundaryActive
    ? canResearchSessionAccessWithoutLegacyNda(location.pathname)
    : hasSignedNDA ||
      isLocalOnboardingPreview(location.pathname, location.search) ||
      canAccessWithoutNda;
  
  if (!canAccess && (status === 'authenticated' || isResearchBoundaryActive)) {
    return null; // Fallback while navigation to /sign-nda completes
  }

  // Render children if access is allowed
  return <>{children}</>;
};

export default GlobalNDAGate;
