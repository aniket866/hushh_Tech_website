import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import config from "../resources/config/config";
import {
  isHushhResearchCallbackRoute,
} from "../services/hushhResearch/contracts";
import {
  clearHushhResearchLocalSession,
  getHushhResearchSessionState,
  isHushhResearchAuthMode,
} from "../services/hushhResearch/firebaseAuth";
import {
  type AuthSessionReason,
  type AuthSessionSnapshot,
  type AuthSessionStatus,
  type OAuthProvider,
  type OAuthStartResult,
  AUTH_EVENT_STORAGE_KEY,
  broadcastAuthEvent,
  clearLegacyAuthStorage,
  clearSupabaseSession,
  getLocalSession,
  getValidatedSession,
  parseAuthBroadcastEvent,
  startUnifiedOAuth,
} from "./session";

interface AuthSessionContextValue extends AuthSessionSnapshot {
  startOAuth: (provider: OAuthProvider) => Promise<OAuthStartResult>;
  signOut: () => Promise<void>;
  revalidateSession: () => Promise<AuthSessionSnapshot>;
  handleAccountDeleted: () => Promise<void>;
}

interface PendingSignedOutState {
  reason: AuthSessionReason;
  status: Extract<AuthSessionStatus, "anonymous" | "invalidated">;
}

const AuthSessionContext = createContext<AuthSessionContextValue | undefined>(
  undefined
);

const INITIAL_SNAPSHOT: AuthSessionSnapshot = {
  status: "booting",
  session: null,
  user: null,
};

export const AuthSessionProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const supabase = config.supabaseClient;
  const [snapshot, setSnapshot] =
    useState<AuthSessionSnapshot>(INITIAL_SNAPSHOT);
  const pendingSignedOutStateRef = useRef<PendingSignedOutState | null>(null);
  const researchModeRef = useRef(isHushhResearchAuthMode());
  const sessionGenerationRef = useRef(0);

  const applySnapshot = useCallback((nextSnapshot: AuthSessionSnapshot) => {
    setSnapshot((currentSnapshot) => {
      const currentUserId = currentSnapshot.user?.id ?? null;
      const nextUserId = nextSnapshot.user?.id ?? null;
      const currentAccessToken = currentSnapshot.session?.access_token ?? null;
      const nextAccessToken = nextSnapshot.session?.access_token ?? null;

      if (
        currentSnapshot.status === nextSnapshot.status &&
        currentSnapshot.reason === nextSnapshot.reason &&
        currentUserId === nextUserId &&
        currentAccessToken === nextAccessToken
      ) {
        return currentSnapshot;
      }

      return nextSnapshot;
    });
  }, []);

  const applyClearedState = useCallback(
    (
      status: Extract<AuthSessionStatus, "anonymous" | "invalidated">,
      reason: AuthSessionReason
    ) => {
      applySnapshot({
        status,
        session: null,
        user: null,
        reason,
      });
    },
    [applySnapshot]
  );

  const clearLocalSession = useCallback(
    async (
      status: Extract<AuthSessionStatus, "anonymous" | "invalidated">,
      reason: AuthSessionReason,
      broadcast = false,
      options: { storageOnly?: boolean } = {}
    ) => {
      const generation = ++sessionGenerationRef.current;
      pendingSignedOutStateRef.current = { status, reason };
      clearLegacyAuthStorage();
      const isResearchSession =
        researchModeRef.current || isHushhResearchAuthMode();
      if (isResearchSession) {
        researchModeRef.current = true;
        clearHushhResearchLocalSession({
          preserveMode: true,
        });
        await clearSupabaseSession(supabase, { storageOnly: true });
      } else {
        await clearSupabaseSession(supabase, options);
      }
      if (generation === sessionGenerationRef.current) {
        applyClearedState(status, reason);
      }
      if (broadcast && generation === sessionGenerationRef.current) {
        broadcastAuthEvent(reason);
      }
      return {
        status,
        session: null,
        user: null,
        reason,
      } satisfies AuthSessionSnapshot;
    },
    [applyClearedState, supabase]
  );

  const revalidateSession = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    const staleSnapshot = (): AuthSessionSnapshot => {
      const pendingState = pendingSignedOutStateRef.current;
      return {
        status: pendingState?.status || "anonymous",
        session: null,
        user: null,
        reason: pendingState?.reason,
      };
    };

    if (researchModeRef.current || isHushhResearchAuthMode()) {
      researchModeRef.current = true;
      const researchState = await getHushhResearchSessionState();
      if (generation !== sessionGenerationRef.current) {
        return staleSnapshot();
      }

      if (researchState.status === "authenticated") {
        await clearSupabaseSession(supabase, { storageOnly: true });
        if (generation !== sessionGenerationRef.current) {
          return staleSnapshot();
        }
        const nextSnapshot: AuthSessionSnapshot = {
          status: "authenticated",
          session: researchState.session,
          user: researchState.user,
        };
        applySnapshot(nextSnapshot);
        return nextSnapshot;
      }

      const nextSnapshot: AuthSessionSnapshot = {
        status:
          researchState.status === "invalidated" ? "invalidated" : "anonymous",
        session: null,
        user: null,
        reason:
          researchState.status === "invalidated"
            ? researchState.reason
            : undefined,
      };
      applySnapshot(nextSnapshot);
      return nextSnapshot;
    }

    const nextSnapshot = await getValidatedSession(supabase);
    if (generation !== sessionGenerationRef.current) {
      return staleSnapshot();
    }

    if (nextSnapshot.status === "invalidated") {
      return clearLocalSession(
        "invalidated",
        nextSnapshot.reason || "invalid_session"
      );
    }

    applySnapshot(nextSnapshot);
    return nextSnapshot;
  }, [applySnapshot, clearLocalSession, supabase]);

  // Boot: Instantly resolve from localStorage (no network call).
  // This eliminates the 'booting' state almost immediately.
  // onAuthStateChange below handles INITIAL_SESSION for the definitive state.
  useEffect(() => {
    const bootFromLocalStorage = async () => {
      if (researchModeRef.current) {
        if (isHushhResearchCallbackRoute(window.location.pathname)) {
          applySnapshot({ status: "anonymous", session: null, user: null });
          return;
        }

        await revalidateSession();
        return;
      }

      const localSnapshot = await getLocalSession(supabase);
      applySnapshot(localSnapshot);
    };
    void bootFromLocalStorage();
  }, [applySnapshot, revalidateSession, supabase]);

  useEffect(() => {
    if (researchModeRef.current) {
      const handleResearchRevalidation = () => {
        void revalidateSession();
      };
      const handleResearchVisibility = () => {
        if (document.visibilityState === "visible") {
          handleResearchRevalidation();
        }
      };
      const handleResearchStorage = (storageEvent: StorageEvent) => {
        if (
          storageEvent.key !== AUTH_EVENT_STORAGE_KEY ||
          !storageEvent.newValue
        ) {
          return;
        }

        const payload = parseAuthBroadcastEvent(storageEvent.newValue);
        if (!payload) {
          return;
        }

        const nextStatus =
          payload.reason === "signed_out" ? "anonymous" : "invalidated";
        void clearLocalSession(nextStatus, payload.reason, false, {
          storageOnly: true,
        });
      };

      window.addEventListener("focus", handleResearchRevalidation);
      window.addEventListener("storage", handleResearchStorage);
      document.addEventListener(
        "visibilitychange",
        handleResearchVisibility
      );

      return () => {
        window.removeEventListener("focus", handleResearchRevalidation);
        window.removeEventListener("storage", handleResearchStorage);
        document.removeEventListener(
          "visibilitychange",
          handleResearchVisibility
        );
      };
    }

    if (!supabase) {
      return;
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, nextSession) => {
      if (researchModeRef.current) {
        return;
      }

      if (event === "SIGNED_OUT" || !nextSession) {
        const pendingState = pendingSignedOutStateRef.current;
        pendingSignedOutStateRef.current = null;

        applySnapshot({
          status: pendingState?.status || "anonymous",
          session: null,
          user: null,
          reason: pendingState?.reason,
        });
        return;
      }

      // Trust the session provided by Supabase events directly.
      // Supabase has already validated the token before firing the event.
      // This eliminates redundant getUser() network calls on every
      // INITIAL_SESSION, SIGNED_IN, and TOKEN_REFRESHED event.
      if (nextSession.user?.id && nextSession.access_token) {
        applySnapshot({
          status: "authenticated",
          session: nextSession,
          user: nextSession.user,
        });
      } else {
        applySnapshot({
          status: "anonymous",
          session: null,
          user: null,
        });
      }
    });

    // Soft revalidation for focus/visibility — only reads localStorage,
    // no server-side getUser() call. This prevents session drops when
    // switching tabs. Supabase's autoRefreshToken handles token renewal.
    const handleSoftRevalidation = async () => {
      if (researchModeRef.current || isHushhResearchAuthMode()) {
        researchModeRef.current = true;
        await revalidateSession();
        return;
      }

      const localSnapshot = await getLocalSession(supabase);

      if (localSnapshot.status === "invalidated") {
        await clearLocalSession(
          "invalidated",
          localSnapshot.reason || "invalid_session"
        );
        return;
      }

      // Only update if local session still exists (no-op if anonymous)
      if (localSnapshot.status === "authenticated") {
        applySnapshot(localSnapshot);
      }
    };

    const handleWindowFocus = () => {
      void handleSoftRevalidation();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void handleSoftRevalidation();
      }
    };

    const handleStorage = (storageEvent: StorageEvent) => {
      if (
        storageEvent.key !== AUTH_EVENT_STORAGE_KEY ||
        !storageEvent.newValue
      ) {
        return;
      }

      const payload = parseAuthBroadcastEvent(storageEvent.newValue);
      if (!payload) {
        return;
      }

      const nextStatus =
        payload.reason === "signed_out" ? "anonymous" : "invalidated";
      void clearLocalSession(nextStatus, payload.reason, false, {
        storageOnly: payload.reason === "deleted",
      });
    };

    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("storage", handleStorage);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("storage", handleStorage);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [applySnapshot, clearLocalSession, revalidateSession, supabase]);

  const startOAuth = useCallback(
    async (provider: OAuthProvider) => {
      if (researchModeRef.current || isHushhResearchAuthMode()) {
        researchModeRef.current = true;
        return {
          ok: false,
          provider,
          reason: "provider_error",
          message: "Use your Research sign-in link.",
        } satisfies OAuthStartResult;
      }

      return startUnifiedOAuth(provider, supabase);
    },
    [supabase]
  );

  const signOut = useCallback(async () => {
    const generation = ++sessionGenerationRef.current;
    clearLegacyAuthStorage();

    if (researchModeRef.current || isHushhResearchAuthMode()) {
      researchModeRef.current = true;
      pendingSignedOutStateRef.current = {
        status: "anonymous",
        reason: "signed_out",
      };
      clearHushhResearchLocalSession({ preserveMode: true });
      await clearSupabaseSession(supabase, { storageOnly: true });
      if (generation === sessionGenerationRef.current) {
        applyClearedState("anonymous", "signed_out");
        broadcastAuthEvent("signed_out");
      }
      return;
    }

    if (!supabase) {
      applyClearedState("anonymous", "signed_out");
      return;
    }

    pendingSignedOutStateRef.current = {
      status: "anonymous",
      reason: "signed_out",
    };

    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error("[AuthSession] Sign-out failed, clearing locally:", error);
      await clearSupabaseSession(supabase);
    }

    if (generation === sessionGenerationRef.current) {
      applyClearedState("anonymous", "signed_out");
      broadcastAuthEvent("signed_out");
    }
  }, [applyClearedState, supabase]);

  const handleAccountDeleted = useCallback(async () => {
    await clearLocalSession("invalidated", "deleted", true, {
      storageOnly: true,
    });
  }, [clearLocalSession]);

  const value = useMemo<AuthSessionContextValue>(
    () => ({
      ...snapshot,
      startOAuth,
      signOut,
      revalidateSession,
      handleAccountDeleted,
    }),
    [handleAccountDeleted, revalidateSession, signOut, snapshot, startOAuth]
  );

  return (
    <AuthSessionContext.Provider value={value}>
      {children}
    </AuthSessionContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- provider and hook intentionally share one context module
export function useAuthSession() {
  const context = useContext(AuthSessionContext);

  if (!context) {
    throw new Error(
      "useAuthSession must be used within an AuthSessionProvider"
    );
  }

  return context;
}

// Isolated presentation tests and embeddable headers may render without the
// app provider. Security-sensitive callers can still consume the Research
// identity hint when the provider is present without weakening useAuthSession.
// eslint-disable-next-line react-refresh/only-export-components -- provider and hooks intentionally share one context module
export function useOptionalAuthSession() {
  return useContext(AuthSessionContext);
}
