import type { Session, User } from "@supabase/supabase-js";

export const HUSHH_RESEARCH_PROJECT_ID = "hushh-pda" as const;
export const HUSHH_RESEARCH_SOURCE = "hushh-research" as const;
export const HUSHH_RESEARCH_CALLBACK_PATH =
  "/auth/hushh-research/callback" as const;
export const HUSHH_RESEARCH_START_ROUTE =
  "/auth/hushh-research/start" as const;
export const HUSHH_RESEARCH_CONFIG_PATH =
  "/api/hushh-research/config" as const;
export const HUSHH_RESEARCH_EXCHANGE_PATH =
  "/api/hushh-research/launch/exchange" as const;
export const HUSHH_RESEARCH_START_PATH =
  "/api/hushh-research/launch/start" as const;
export const HUSHH_RESEARCH_LAUNCH_ORIGIN =
  "https://uat.one.hushh.ai" as const;
export const HUSHH_RESEARCH_LAUNCH_PATH =
  "/products/hushh-tech/launch" as const;
export const HUSHH_RESEARCH_PRODUCT_CLIENT = "hushh-tech" as const;
export const HUSHH_RESEARCH_PRODUCT_CLIENT_APP_ID =
  "app_hushh-technologies_cd1895ef" as const;
export const HUSHH_RESEARCH_PRODUCT_AUDIENCE = "hushh-tech-uat" as const;

export function normalizeHushhResearchAuthPath(pathname: string): string {
  const pathOnly = pathname.trim().split(/[?#]/, 1)[0].toLowerCase();
  return pathOnly.length > 1 ? pathOnly.replace(/\/+$/, "") : pathOnly;
}

export function isHushhResearchStartRoute(pathname: string): boolean {
  return (
    normalizeHushhResearchAuthPath(pathname) === HUSHH_RESEARCH_START_ROUTE
  );
}

export function isHushhResearchCallbackRoute(pathname: string): boolean {
  return (
    normalizeHushhResearchAuthPath(pathname) === HUSHH_RESEARCH_CALLBACK_PATH
  );
}

export function isHushhResearchAuthRoute(pathname: string): boolean {
  return (
    isHushhResearchStartRoute(pathname) ||
    isHushhResearchCallbackRoute(pathname)
  );
}

export type HushhResearchLinkState = "READY" | "LINK_REQUIRED";

export interface HushhResearchFirebasePublicConfig {
  apiKey: string;
  authDomain: string;
  projectId: typeof HUSHH_RESEARCH_PROJECT_ID;
  appId: string;
}

export interface HushhResearchLaunchConfig {
  audience: string;
  redirectUri: string;
  startPath: typeof HUSHH_RESEARCH_START_PATH;
}

export interface HushhResearchPublicConfig {
  enabled: true;
  firebase: HushhResearchFirebasePublicConfig;
  launch: HushhResearchLaunchConfig;
}

export type HushhResearchConfigDisabledReason =
  | "production_disabled"
  | "feature_disabled"
  | "config_unavailable"
  | "invalid_config";

export type HushhResearchConfigState =
  | {
      status: "enabled";
      config: HushhResearchPublicConfig;
    }
  | {
      status: "disabled";
      reason: HushhResearchConfigDisabledReason;
    };

export interface HushhResearchLaunchExchangeInput {
  code: string;
  state: string;
  source: typeof HUSHH_RESEARCH_SOURCE;
}

export interface HushhResearchLaunchExchangeResponse {
  firebase_custom_token: string;
  expires_in: number;
  canonical_user_id: string;
  audience: string;
  state: string;
  link_state: HushhResearchLinkState;
}

export interface HushhResearchFirebaseSession {
  version: 1;
  provider: "firebase";
  projectId: typeof HUSHH_RESEARCH_PROJECT_ID;
  audience: string;
  linkState: HushhResearchLinkState;
  launchAuthorizationId: string;
  launchValidAfterMs: number;
  uid: string;
  idToken: string;
  refreshToken: string;
  email?: string;
  displayName?: string;
  issuedAt: number;
  expiresAt: number;
}

export type HushhResearchSessionState =
  | { status: "inactive" }
  | { status: "anonymous" }
  | {
      status: "authenticated";
      session: Session;
      user: User;
    }
  | {
      status: "invalidated";
      reason: "expired" | "invalid_session";
    };

export type HushhResearchLaunchFailureReason =
  | "invalid_callback"
  | "feature_disabled"
  | "exchange_rejected"
  | "firebase_sign_in_failed"
  | "persistence_failed";

export type HushhResearchLaunchResult =
  | {
      ok: true;
      uid: string;
      linkState: HushhResearchLinkState;
    }
  | {
      ok: false;
      reason: HushhResearchLaunchFailureReason;
    };

export type HushhResearchLaunchStartFailureReason =
  | "feature_disabled"
  | "start_rejected"
  | "invalid_launch_url";

export type HushhResearchLaunchStartResult =
  | {
      ok: true;
      launchUrl: string;
      expiresIn: number;
    }
  | {
      ok: false;
      reason: HushhResearchLaunchStartFailureReason;
    };
