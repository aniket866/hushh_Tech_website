/**
 * Deployments dashboard logic — Firebase claim gate + data loading.
 * The server independently verifies the signed token and custom claim.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuthSession } from "../../auth/AuthSessionProvider";

export interface Deployment {
  env: "UAT" | "PROD";
  revision: string;
  createdAt: string | null;
  isLive: boolean;
  buildUrl: string | null;
  image: string | null;
}

export function useDeploymentsDashboard() {
  const { session, signOut, status, user } = useAuthSession();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [envErrors, setEnvErrors] = useState<{ env: string; error: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasAdminClaim = user?.app_metadata?.deployment_admin === true;
  const accessToken = session?.access_token ?? null;
  const isAuthed = status === "authenticated" && hasAdminClaim && Boolean(accessToken);

  const clear = useCallback(() => {
    setDeployments([]);
    setEnvErrors([]);
    setError(null);
  }, []);

  const load = useCallback(
    async (token: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/deployments", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        const data = await res
          .json()
          .catch(() => ({ success: false, error: "Invalid response" }));
        if (!res.ok || !data.success) {
          if (res.status === 401) {
            await signOut();
            clear();
            throw new Error("Session expired — please sign in again.");
          }
          throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
        }
        setDeployments(Array.isArray(data.deployments) ? data.deployments : []);
        setEnvErrors(Array.isArray(data.errors) ? data.errors : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load deployments.");
      } finally {
        setLoading(false);
      }
    },
    [clear, signOut],
  );

  useEffect(() => {
    if (isAuthed && accessToken) void load(accessToken);
    else clear();
  }, [accessToken, clear, isAuthed, load]);

  return {
    authStatus: status,
    hasAdminClaim,
    isAuthed,
    signOut,
    deployments,
    envErrors,
    loading,
    error,
    refresh: () => {
      if (isAuthed && accessToken) void load(accessToken);
    },
  };
}
