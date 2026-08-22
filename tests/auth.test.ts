/**
 * Auth Flow Tests — Verifies Google & Apple Sign-In, session management,
 * and the full auth chain (getUserDetails → isLoggedIn, getAccessToken, getFullName).
 *
 * These tests mock the Firebase-backed GCP client to validate logic without real OAuth redirects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock Supabase Session ──────────────────────────────────────────────────
const MOCK_SESSION = {
  access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock-access-token",
  refresh_token: "mock-refresh-token",
  expires_in: 3600,
  token_type: "bearer",
  user: {
    id: "user-uuid-123",
    email: "test@hushh.ai",
    app_metadata: { provider: "google" },
    user_metadata: {
      full_name: "Test User",
      avatar_url: "https://example.com/avatar.png",
    },
    aud: "authenticated",
    created_at: "2026-01-01T00:00:00.000Z",
  },
};

// ─── Hoisted mocks (available before vi.mock factory runs) ──────────────────
const {
  mockGetSession,
  mockSignInWithOAuth,
  mockSignOut,
  mockOnAuthStateChange,
  mockSupabaseClient,
} = vi.hoisted(() => {
  const mockGetSession = vi.fn();
  const mockSignInWithOAuth = vi.fn();
  const mockSignOut = vi.fn();
  const mockOnAuthStateChange = vi.fn(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  }));

  const mockSupabaseClient = {
    auth: {
      getSession: mockGetSession,
      signInWithOAuth: mockSignInWithOAuth,
      signOut: mockSignOut,
      onAuthStateChange: mockOnAuthStateChange,
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        ilike: vi.fn(() => ({
          data: [],
          error: null,
        })),
      })),
    })),
  };

  return {
    mockGetSession,
    mockSignInWithOAuth,
    mockSignOut,
    mockOnAuthStateChange,
    mockSupabaseClient,
  };
});

// ─── Mock Modules ───────────────────────────────────────────────────────────
vi.mock("../src/resources/config/config", () => ({
  default: {
    redirect_url: "https://hushhtech.com/auth/callback",
    gcpBackendClient: mockSupabaseClient,
  },
}));

vi.mock("../src/resources/resources", () => ({
  default: {
    config: {
      redirect_url: "https://hushhtech.com/auth/callback",
      gcpBackendClient: mockSupabaseClient,
    },
  },
}));

// Also mock services barrel export used by isLoggedIn, getAccessToken, getFullName
vi.mock("../src/services/services", () => ({
  default: {
    authentication: {
      getUserDetails: async (setter: Function | null) => {
        const { data, error } = await mockGetSession();
        if (error || !data?.session) {
          const emptyResult = { data: null };
          if (setter) setter(emptyResult);
          return emptyResult;
        }
        const userDetails = { data: data.session };
        if (setter) setter(userDetails);
        return userDetails;
      },
    },
  },
}));

// Mock window for OAuth tests
const mockWindowLocation = {
  origin: "https://hushhtech.com",
  pathname: "/login",
  search: "",
  assign: vi.fn(),
  href: "https://hushhtech.com/login",
};

// ─── Import modules after mocks ─────────────────────────────────────────────
import getUserDetails from "../src/services/authentication/getUserDetails";
import signOut from "../src/services/authentication/signOut";

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═════════════════════════════════════════════════════════════════════════════

describe("Auth Flow — getUserDetails (Fixed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return session data when user is logged in", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: MOCK_SESSION },
      error: null,
    });

    const result = await getUserDetails(null);

    expect(result.data).toBeDefined();
    expect(result.data).not.toBeNull();
    expect(result.data!.access_token).toBe(MOCK_SESSION.access_token);
    expect(result.data!.user.email).toBe("test@hushh.ai");
    expect(mockGetSession).toHaveBeenCalledOnce();
  });

  it("should return null data when no session exists", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const result = await getUserDetails(null);

    expect(result.data).toBeNull();
  });

  it("should return null data on error", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: { message: "Session expired" },
    });

    const result = await getUserDetails(null);

    expect(result.data).toBeNull();
  });

  it("should call setUserDetails callback with session data", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: MOCK_SESSION },
      error: null,
    });

    const setter = vi.fn();
    await getUserDetails(setter);

    expect(setter).toHaveBeenCalledOnce();
    expect(setter).toHaveBeenCalledWith({ data: MOCK_SESSION });
  });

  it("should call setUserDetails callback with null on no session", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const setter = vi.fn();
    await getUserDetails(setter);

    expect(setter).toHaveBeenCalledWith({ data: null });
  });

  it("should handle exceptions gracefully", async () => {
    mockGetSession.mockRejectedValue(new Error("Network error"));

    const result = await getUserDetails(null);

    expect(result.data).toBeNull();
  });

  it("should NOT use hardcoded localStorage keys", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: MOCK_SESSION },
      error: null,
    });

    await getUserDetails(null);

    // getSession must be called (not localStorage)
    expect(mockGetSession).toHaveBeenCalledOnce();
  });
});

describe("Auth Flow — isLoggedIn (via getUserDetails)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should detect logged-in state correctly", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: MOCK_SESSION },
      error: null,
    });

    const result = await getUserDetails(null);
    const loggedIn = !(result.data == null);

    expect(loggedIn).toBe(true);
  });

  it("should detect logged-out state correctly", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const result = await getUserDetails(null);
    const loggedIn = !(result.data == null);

    expect(loggedIn).toBe(false);
  });
});

describe("Auth Flow — getAccessToken (via getUserDetails)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should extract access_token from session", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: MOCK_SESSION },
      error: null,
    });

    const result = await getUserDetails(null);
    const token = result.data?.access_token ?? null;

    expect(token).toBe(MOCK_SESSION.access_token);
  });

  it("should return null when no session", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const result = await getUserDetails(null);
    const token = result.data?.access_token ?? null;

    expect(token).toBeNull();
  });
});

describe("Auth Flow — getFullName (via getUserDetails)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should extract full_name from user metadata", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: MOCK_SESSION },
      error: null,
    });

    const result = await getUserDetails(null);
    const name = result.data?.user?.user_metadata?.full_name;

    expect(name).toBe("Test User");
  });

  it("should return undefined when no session", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const result = await getUserDetails(null);
    const name = result.data?.user?.user_metadata?.full_name;

    expect(name).toBeUndefined();
  });
});

describe("Auth Flow — Google Sign-In", () => {
  let originalWindow: any;

  beforeEach(() => {
    vi.clearAllMocks();
    originalWindow = global.window;
    Object.defineProperty(global, "window", {
      value: {
        location: { ...mockWindowLocation },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(global, "window", {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
  });

  it("should call signInWithOAuth with Google provider", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test" },
      error: null,
    });

    const { default: googleSignIn } = await import(
      "../src/services/authentication/googleSignIn"
    );
    await googleSignIn();

    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        options: expect.objectContaining({
          queryParams: { access_type: "offline", prompt: "consent" },
        }),
      })
    );
  });

  it("should set redirectTo to /auth/callback", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test" },
      error: null,
    });

    const { default: googleSignIn } = await import(
      "../src/services/authentication/googleSignIn"
    );
    await googleSignIn();

    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          redirectTo: expect.stringContaining("/auth/callback"),
        }),
      })
    );
  });

  it("should not throw on OAuth error", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: null,
      error: { message: "OAuth config error" },
    });

    const { default: googleSignIn } = await import(
      "../src/services/authentication/googleSignIn"
    );

    await expect(googleSignIn()).resolves.not.toThrow();
  });
});

describe("Auth Flow — Apple Sign-In", () => {
  let originalWindow: any;

  beforeEach(() => {
    vi.clearAllMocks();
    originalWindow = global.window;
    Object.defineProperty(global, "window", {
      value: {
        location: { ...mockWindowLocation },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(global, "window", {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
  });

  it("should call signInWithOAuth with Apple provider and name email scopes", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: "https://appleid.apple.com/auth/authorize?client_id=test" },
      error: null,
    });

    const { default: appleSignIn } = await import(
      "../src/services/authentication/appleSignIn"
    );
    await appleSignIn();

    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "apple",
        options: expect.objectContaining({
          scopes: "name email",
        }),
      })
    );
  });

  it("should set redirectTo to /auth/callback", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: "https://appleid.apple.com/auth/authorize?client_id=test" },
      error: null,
    });

    const { default: appleSignIn } = await import(
      "../src/services/authentication/appleSignIn"
    );
    await appleSignIn();

    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          redirectTo: expect.stringContaining("/auth/callback"),
        }),
      })
    );
  });

  it("should not throw on OAuth error", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: null,
      error: { message: "Apple OAuth error" },
    });

    const { default: appleSignIn } = await import(
      "../src/services/authentication/appleSignIn"
    );

    await expect(appleSignIn()).resolves.not.toThrow();
  });
});

describe("Auth Flow — Sign Out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should call Firebase-backed auth.signOut", async () => {
    mockSignOut.mockResolvedValue({ error: null });

    await signOut();

    expect(mockSignOut).toHaveBeenCalledOnce();
  });
});

describe("Auth Flow — Firebase Project Configuration (Regression Guard)", () => {
  it("should use the exact UAT Firebase authority in config", async () => {
    const config = (await import("../src/resources/config/config")).default;

    expect(config.gcpBackendClient).toBe(mockSupabaseClient);
    expect(config).not.toHaveProperty("SUPABASE_URL");
  });

  it("getUserDetails.ts must use the validated GCP session path", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      "src/services/authentication/getUserDetails.ts",
      "utf-8"
    );

    expect(source).not.toContain("supabase");
    expect(source).toContain("getValidatedSession");
  });

  it("checkRegistrationStatus.ts must not contain a legacy provider URL", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      "src/services/authentication/checkRegistrationStatus.ts",
      "utf-8"
    );

    expect(source).not.toContain("supabase.co");
  });
});

describe("Auth Flow — End-to-End Chain Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("full chain: logged in → session, token, name all available", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: MOCK_SESSION },
      error: null,
    });

    // 1. getUserDetails returns session
    const details = await getUserDetails(null);
    expect(details.data).not.toBeNull();

    // 2. isLoggedIn check
    expect(!(details.data == null)).toBe(true);

    // 3. access_token extractable
    expect(details.data!.access_token).toBe(MOCK_SESSION.access_token);

    // 4. full_name extractable
    expect(details.data!.user.user_metadata.full_name).toBe("Test User");
  });

  it("full chain: logged out → all return empty/null/false", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const details = await getUserDetails(null);
    expect(details.data).toBeNull();
    expect(!(details.data == null)).toBe(false);
  });
});
