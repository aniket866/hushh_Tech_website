import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthSession } from '../auth/AuthSessionProvider';
import { buildLoginRedirectPath } from '../auth/routePolicy';

interface FundAdminRouteProps {
  children: React.ReactNode;
}

/**
 * Gate for the internal Hushh Fund verification dashboard (`/fund-admin`).
 * Unlike ProtectedRoute, this must NOT run the investor onboarding flow —
 * team members are not investors, so we never bounce them to financial-link.
 * The real authorization lives server-side. This guard mirrors the exact
 * Firebase custom claim and never treats an email address as authority.
 */
const FundAdminRoute: React.FC<FundAdminRouteProps> = ({ children }) => {
  const { status, user } = useAuthSession();
  const location = useLocation();

  if (status === 'booting') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0066CC] mx-auto" />
          <p className="mt-4 text-gray-600">Loading…</p>
        </div>
      </div>
    );
  }

  if (status !== 'authenticated' || !user) {
    return (
      <Navigate
        to={buildLoginRedirectPath(location.pathname, location.search, location.hash)}
        replace
      />
    );
  }

  if (user.app_metadata?.fund_admin !== true) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export default FundAdminRoute;
