/**
 * Home Page — All Business Logic
 *
 * Contains:
 * - Shared onboarding/profile CTA determination
 * - Navigation handler
 */
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Session } from "@/services/gcpBackend/types";
import { useInvestorJourneyCta } from "../../hooks/useInvestorJourneyCta";

/* ─── Types ─── */
export interface PrimaryCTA {
  text: string;
  action: () => void;
  loading: boolean;
  progressLabel?: string | null;
}

export interface HomeLogic {
  session: Session | null;
  primaryCTA: PrimaryCTA;
  onNavigate: (path: string) => void;
}

/* ─── Main Hook ─── */
export const useHomeLogic = (): HomeLogic => {
  const navigate = useNavigate();
  const { session, primaryCTA } = useInvestorJourneyCta();

  /* Navigation helper */
  const onNavigate = useCallback(
    (path: string) => {
      navigate(path);
    },
    [navigate]
  );

  return {
    session,
    primaryCTA,
    onNavigate,
  };
};
