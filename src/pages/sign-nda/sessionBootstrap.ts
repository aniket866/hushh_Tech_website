import type { AuthChangeEvent, Session } from '@/services/gcpBackend/types';

interface AuthSubscription {
  unsubscribe: () => void;
}

export interface SignNDASessionClient {
  auth: {
    getSession: () => Promise<{ data: { session: Session | null } }>;
    onAuthStateChange: (
      callback: (event: AuthChangeEvent, session: Session | null) => void
    ) => { data: { subscription: AuthSubscription } };
  };
}

export type SignNDASessionSource =
  | 'current_session'
  | 'auth_event'
  | 'timeout'
  | 'missing_client'
  | 'error';

export interface SignNDASessionResolution {
  session: Session | null;
  source: SignNDASessionSource;
  error?: Error;
}

export const SIGN_NDA_SESSION_TIMEOUT_MS = 1500;

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function resolveSignNDASession(
  client: SignNDASessionClient | undefined,
  timeoutMs: number = SIGN_NDA_SESSION_TIMEOUT_MS
): Promise<SignNDASessionResolution> {
  if (!client) {
    return {
      session: null,
      source: 'missing_client',
    };
  }

  try {
    const {
      data: { session },
    } = await client.auth.getSession();

    if (session?.user) {
      return {
        session,
        source: 'current_session',
      };
    }

    return await new Promise<SignNDASessionResolution>((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let subscription: AuthSubscription | null = null;

      const finish = (result: SignNDASessionResolution) => {
        if (settled) {
          return;
        }

        settled = true;

        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        subscription?.unsubscribe();
        resolve(result);
      };

      const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
        if (nextSession?.user) {
          finish({
            session: nextSession,
            source: 'auth_event',
          });
        }
      });

      subscription = data.subscription;

      timeoutHandle = setTimeout(() => {
        finish({
          session: null,
          source: 'timeout',
        });
      }, timeoutMs);
    });
  } catch (error) {
    return {
      session: null,
      source: 'error',
      error: normalizeError(error),
    };
  }
}
