import React, { type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import config from "../resources/config/config";
import {
  isHushhResearchAuthRoute,
  normalizeHushhResearchAuthPath,
} from "../services/hushhResearch/contracts";

interface HushhResearchHardEntryGuardProps {
  children: ReactNode;
  replaceLocation?: (target: string) => void;
}

export default function HushhResearchHardEntryGuard({
  children,
  replaceLocation = (target) => window.location.replace(target),
}: HushhResearchHardEntryGuardProps) {
  const location = useLocation();
  const legacyClient = config.supabaseClient;
  const requiresCleanEntry =
    isHushhResearchAuthRoute(location.pathname) && Boolean(legacyClient);

  if (requiresCleanEntry) {
    try {
      legacyClient?.auth.stopAutoRefresh();
    } catch {
      // The reload still removes the initialized legacy client boundary.
    }
    replaceLocation(
      `${normalizeHushhResearchAuthPath(location.pathname)}` +
        `${location.search}${location.hash}`,
    );
    return null;
  }

  return <>{children}</>;
}
