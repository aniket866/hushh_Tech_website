import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../src/resources/resources", () => ({
  default: {
    config: {
      gcpBackendClient: {
        auth: { getSession: mocks.getSession },
      },
    },
  },
}));

import {
  getOwnHushhProfile,
  getPublicHushhProfile,
  updateOwnHushhProfile,
} from "../src/services/preferences/hushhProfileApi";

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe("Hushh profile browser client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("uses the authenticated profile endpoint with the Firebase session token", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: "firebase-token" } }, error: null });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ data: { profile: null } }));

    await getOwnHushhProfile();

    expect(fetchMock).toHaveBeenCalledWith("/api/hushh-profile", expect.objectContaining({
      credentials: "same-origin",
      headers: expect.objectContaining({ Authorization: "Bearer firebase-token" }),
    }));
  });

  it("sends editable profile data only on update", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: "firebase-token" } }, error: null });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ data: {} }));
    const input = { name: "A User", organisation: "Hushh", profile: {} } as any;

    await updateOwnHushhProfile(input);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(init.method).toBe("PUT");
    expect(body).toEqual(input);
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("firebase_uid");
  });

  it("uses a public same-origin endpoint without an auth header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ data: { profile: {} } }));

    await getPublicHushhProfile("public-id");

    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/public/hushh-profile/public-id", expect.objectContaining({
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }));
  });
});
