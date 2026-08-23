import { describe, expect, it, vi } from "vitest";
import {
  HUSHH_RESEARCH_CALLBACK_PATH,
  HUSHH_RESEARCH_CONFIG_PATH,
  HUSHH_RESEARCH_EXCHANGE_PATH,
  HUSHH_RESEARCH_PRODUCT_AUDIENCE,
  HUSHH_RESEARCH_PRODUCT_CLIENT,
  HUSHH_RESEARCH_PRODUCT_CLIENT_APP_ID,
  HUSHH_RESEARCH_PROJECT_ID,
  HUSHH_RESEARCH_SOURCE,
  HUSHH_RESEARCH_START_PATH,
  HUSHH_RESEARCH_START_ROUTE,
} from "../src/services/hushhResearch/contracts";
import { createHushhResearchAuthClient } from "../src/services/hushhResearch/firebaseAuth";

const NOW = 1_700_000_000_000;
const UAT_LOCATION = {
  hostname: "uat.hushhtech.com",
  origin: "https://uat.hushhtech.com",
  pathname: "/",
};

const ENABLED_CONFIG = {
  enabled: true,
  firebase: {
    apiKey: "public-firebase-api-key",
    authDomain: "hushh-pda-uat.firebaseapp.com",
    projectId: HUSHH_RESEARCH_PROJECT_ID,
    appId: "1:123:web:abc",
  },
  launch: {
    audience: HUSHH_RESEARCH_PRODUCT_AUDIENCE,
    redirectUri: `${UAT_LOCATION.origin}${HUSHH_RESEARCH_CALLBACK_PATH}`,
    startPath: HUSHH_RESEARCH_START_PATH,
  },
};

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  serializedValues() {
    return Array.from(this.values.values()).join("\n");
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function idToken(
  uid = "firebase-uid-123",
  claimOverrides: Record<string, unknown> = {}
) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: HUSHH_RESEARCH_PROJECT_ID,
      iss: `https://securetoken.google.com/${HUSHH_RESEARCH_PROJECT_ID}`,
      sub: uid,
      email: "researcher@hushh.ai",
      name: "Research User",
      product_client: HUSHH_RESEARCH_PRODUCT_CLIENT,
      product_client_app_id: HUSHH_RESEARCH_PRODUCT_CLIENT_APP_ID,
      product_audience: HUSHH_RESEARCH_PRODUCT_AUDIENCE,
      product_launch_authorization_id: "launch-authorization-123",
      product_launch_valid_after_ms: NOW - 1_000,
      ...claimOverrides,
    })
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

function createClient(fetchMock: ReturnType<typeof vi.fn>, storage = new MemoryStorage()) {
  return {
    client: createHushhResearchAuthClient({
      fetchImpl: fetchMock as typeof fetch,
      storage,
      location: UAT_LOCATION,
      now: () => NOW,
    }),
    storage,
  };
}

describe("Hushh Research Firebase auth client", () => {
  it.each([
    HUSHH_RESEARCH_START_ROUTE,
    HUSHH_RESEARCH_CALLBACK_PATH,
    "/AUTH/HUSHH-RESEARCH/START/",
    "/Auth/Hushh-Research/Callback///",
  ])(
    "activates Research mode synchronously on %s",
    (pathname) => {
      const client = createHushhResearchAuthClient({
        fetchImpl: vi.fn() as typeof fetch,
        storage: new MemoryStorage(),
        location: { ...UAT_LOCATION, pathname },
        now: () => NOW,
      });

      expect(client.isAuthMode()).toBe(true);
    },
  );

  it("keeps the Research boundary after local logout without retaining tokens", async () => {
    const storage = new MemoryStorage();
    storage.setItem("hushh_research_auth_mode", "firebase-v1");
    storage.setItem("hushh_research_firebase_session", "sensitive-session");
    const { client } = createClient(vi.fn(), storage);

    client.clearLocalSession({ preserveMode: true });

    expect(client.isAuthMode()).toBe(true);
    expect(storage.serializedValues()).not.toContain("sensitive-session");
    await expect(client.getSessionState()).resolves.toEqual({
      status: "anonymous",
    });
  });

  it("keeps an in-memory Research boundary if browser storage disappears", () => {
    const storage = new MemoryStorage();
    storage.setItem("hushh_research_auth_mode", "firebase-v1");
    const { client } = createClient(vi.fn(), storage);

    expect(client.isAuthMode()).toBe(true);
    storage.removeItem("hushh_research_auth_mode");

    expect(client.isAuthMode()).toBe(true);
  });

  it("defaults disabled when runtime config is unavailable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    const { client } = createClient(fetchMock);

    await expect(client.getRuntimeConfig()).resolves.toEqual({
      status: "disabled",
      reason: "config_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      HUSHH_RESEARCH_CONFIG_PATH,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      })
    );
  });

  it("hard-disables production before making a request", async () => {
    const fetchMock = vi.fn();
    const client = createHushhResearchAuthClient({
      fetchImpl: fetchMock as typeof fetch,
      storage: new MemoryStorage(),
      location: {
        hostname: "hushhtech.com",
        origin: "https://hushhtech.com",
        pathname: HUSHH_RESEARCH_CALLBACK_PATH,
      },
      now: () => NOW,
    });

    await expect(client.getRuntimeConfig()).resolves.toEqual({
      status: "disabled",
      reason: "production_disabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges the bound launch and exposes the Firebase UID canonically", async () => {
    const firebaseIdToken = idToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({
          firebase_custom_token: "single-use-custom-token",
          expires_in: 60,
          canonical_user_id: "firebase-uid-123",
          audience: HUSHH_RESEARCH_PRODUCT_AUDIENCE,
          state: "callback-state-123",
          link_state: "READY",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          idToken: firebaseIdToken,
          refreshToken: "firebase-refresh-token",
          expiresIn: "3600",
          localId: "firebase-uid-123",
        })
      )
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({
          id_token: firebaseIdToken,
          refresh_token: "firebase-refresh-token-2",
          expires_in: "3600",
          user_id: "firebase-uid-123",
        })
      );
    const { client, storage } = createClient(fetchMock);

    const callbackInput = {
      code: "single-use-code",
      state: "callback-state-123",
      source: HUSHH_RESEARCH_SOURCE,
    } as const;
    const firstCompletion = client.completeLaunch(callbackInput);
    const duplicateCompletion = client.completeLaunch(callbackInput);
    expect(duplicateCompletion).toBe(firstCompletion);
    await expect(firstCompletion).resolves.toEqual({
      ok: true,
      uid: "firebase-uid-123",
      linkState: "READY",
    });

    expect(fetchMock.mock.calls[1]).toEqual([
      HUSHH_RESEARCH_EXCHANGE_PATH,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          code: "single-use-code",
          state: "callback-state-123",
          source: HUSHH_RESEARCH_SOURCE,
        }),
      }),
    ]);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken"
    );
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        credentials: "omit",
        body: JSON.stringify({
          token: "single-use-custom-token",
          returnSecureToken: true,
        }),
      })
    );
    expect(storage.serializedValues()).not.toContain("single-use-custom-token");

    const sessionState = await client.getSessionState();
    expect(sessionState.status).toBe("authenticated");
    if (sessionState.status === "authenticated") {
      expect(sessionState.user.id).toBe("firebase-uid-123");
      expect(sessionState.session.user.id).toBe("firebase-uid-123");
      expect(sessionState.session.access_token).toBe(firebaseIdToken);
      expect(sessionState.user.app_metadata).toMatchObject({
        provider: "firebase",
        auth_source: HUSHH_RESEARCH_SOURCE,
        research_link_state: "READY",
      });
    }
  });

  it("rejects a Firebase token without the bound Tech product claims", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({
          firebase_custom_token: "custom-token",
          expires_in: 60,
          canonical_user_id: "firebase-uid-123",
          audience: HUSHH_RESEARCH_PRODUCT_AUDIENCE,
          state: "callback-state-123",
          link_state: "LINK_REQUIRED",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          idToken: idToken("firebase-uid-123", {
            product_client: "another-client",
          }),
          refreshToken: "firebase-refresh-token",
          expiresIn: "3600",
          localId: "firebase-uid-123",
        })
      );
    const { client, storage } = createClient(fetchMock);

    await expect(
      client.completeLaunch({
        code: "single-use-code",
        state: "callback-state-123",
        source: HUSHH_RESEARCH_SOURCE,
      })
    ).resolves.toEqual({
      ok: false,
      reason: "firebase_sign_in_failed",
    });
    expect(client.isAuthMode()).toBe(true);
    expect(storage.serializedValues()).not.toContain("firebase-refresh-token");
  });

  it("revalidates a persisted session through Firebase before restoring it", async () => {
    const storage = new MemoryStorage();
    const initialFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({
          firebase_custom_token: "custom-token",
          expires_in: 60,
          canonical_user_id: "firebase-uid-123",
          audience: HUSHH_RESEARCH_PRODUCT_AUDIENCE,
          state: "callback-state-123",
          link_state: "READY",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          idToken: idToken(),
          refreshToken: "firebase-refresh-token",
          expiresIn: "3600",
          localId: "firebase-uid-123",
        })
      );
    const { client: initialClient } = createClient(initialFetch, storage);
    await initialClient.completeLaunch({
      code: "single-use-code",
      state: "callback-state-123",
      source: HUSHH_RESEARCH_SOURCE,
    });

    const reloadFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({
          id_token: idToken("firebase-uid-123", {
            product_client: "another-client",
          }),
          refresh_token: "fresh-refresh-token",
          expires_in: "3600",
          user_id: "firebase-uid-123",
        })
      );
    const { client: reloadedClient } = createClient(reloadFetch, storage);

    await expect(reloadedClient.getSessionState()).resolves.toEqual({
      status: "invalidated",
      reason: "invalid_session",
    });
    expect(String(reloadFetch.mock.calls[1]?.[0])).toContain(
      "securetoken.googleapis.com/v1/token"
    );
    expect(reloadedClient.isAuthMode()).toBe(true);
    expect(storage.serializedValues()).not.toContain("firebase-refresh-token");
  });

  it("rejects a mismatched callback state before Firebase sign-in", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({
          firebase_custom_token: "custom-token",
          expires_in: 60,
          canonical_user_id: "firebase-uid-123",
          audience: HUSHH_RESEARCH_PRODUCT_AUDIENCE,
          state: "different-state",
          link_state: "READY",
        })
      );
    const { client } = createClient(fetchMock);

    await expect(
      client.completeLaunch({
        code: "single-use-code",
        state: "callback-state-123",
        source: HUSHH_RESEARCH_SOURCE,
      })
    ).resolves.toEqual({ ok: false, reason: "exchange_rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes only when the product claim binding remains unchanged", async () => {
    const firstIdToken = idToken();
    const refreshedIdToken = idToken("firebase-uid-123", {
      email: "fresh@hushh.ai",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({
          firebase_custom_token: "custom-token",
          expires_in: 60,
          canonical_user_id: "firebase-uid-123",
          audience: HUSHH_RESEARCH_PRODUCT_AUDIENCE,
          state: "callback-state-123",
          link_state: "READY",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          idToken: firstIdToken,
          refreshToken: "firebase-refresh-token",
          expiresIn: "30",
          localId: "firebase-uid-123",
        })
      )
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({
          id_token: refreshedIdToken,
          refresh_token: "fresh-refresh-token",
          expires_in: "3600",
          user_id: "firebase-uid-123",
        })
      );
    const { client } = createClient(fetchMock);

    await client.completeLaunch({
      code: "single-use-code",
      state: "callback-state-123",
      source: HUSHH_RESEARCH_SOURCE,
    });
    const sessionState = await client.getSessionState();

    expect(sessionState.status).toBe("authenticated");
    if (sessionState.status === "authenticated") {
      expect(sessionState.session.access_token).toBe(refreshedIdToken);
      expect(sessionState.user.email).toBe("fresh@hushh.ai");
    }
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain(
      "securetoken.googleapis.com/v1/token"
    );
  });

  it("does not persist a refresh that completes after local sign-out", async () => {
    const storage = new MemoryStorage();
    const initialFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({
          firebase_custom_token: "custom-token",
          expires_in: 60,
          canonical_user_id: "firebase-uid-123",
          audience: HUSHH_RESEARCH_PRODUCT_AUDIENCE,
          state: "callback-state-123",
          link_state: "READY",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          idToken: idToken(),
          refreshToken: "firebase-refresh-token",
          expiresIn: "30",
          localId: "firebase-uid-123",
        })
      );
    const { client: initialClient } = createClient(initialFetch, storage);
    await initialClient.completeLaunch({
      code: "single-use-code",
      state: "callback-state-123",
      source: HUSHH_RESEARCH_SOURCE,
    });

    let resolveRefresh: ((response: Response) => void) | undefined;
    const reloadFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRefresh = resolve;
          })
      );
    const { client } = createClient(reloadFetch, storage);
    const pendingState = client.getSessionState();
    await vi.waitFor(() => {
      expect(reloadFetch).toHaveBeenCalledTimes(2);
    });
    expect(resolveRefresh).toBeTypeOf("function");

    client.clearLocalSession();
    resolveRefresh?.(
      jsonResponse({
        id_token: idToken(),
        refresh_token: "late-refresh-token",
        expires_in: "3600",
        user_id: "firebase-uid-123",
      })
    );

    await expect(pendingState).resolves.toEqual({ status: "anonymous" });
    expect(storage.serializedValues()).not.toContain("late-refresh-token");
    expect(client.isAuthMode()).toBe(true);
  });

  it("starts only the exact UAT Research launch URL", async () => {
    const launchUrl =
      "https://uat.one.hushh.ai/products/hushh-tech/launch?launch_id=once";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({ launch_url: launchUrl, expires_in: 60 })
      );
    const { client } = createClient(fetchMock);

    await expect(client.startLaunch()).resolves.toEqual({
      ok: true,
      launchUrl,
      expiresIn: 60,
    });
    expect(fetchMock.mock.calls[1]).toEqual([
      HUSHH_RESEARCH_START_PATH,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ source: HUSHH_RESEARCH_SOURCE }),
      }),
    ]);
  });

  it("rejects a launch URL outside the exact UAT gateway path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ENABLED_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse({
          launch_url:
            "https://attacker.example/products/hushh-tech/launch?launch_id=once",
          expires_in: 60,
        })
      );
    const { client } = createClient(fetchMock);

    await expect(client.startLaunch()).resolves.toEqual({
      ok: false,
      reason: "invalid_launch_url",
    });
  });
});
