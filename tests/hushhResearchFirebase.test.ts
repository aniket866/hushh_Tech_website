import { describe, expect, it, vi } from "vitest";

import {
  HushhResearchAuthError,
  verifyHushhResearchFirebaseToken,
} from "../api/shared/hushhResearchFirebase.js";

const NOW_SECONDS = 1_787_000_000;
const UID = "hushh-tech-uat-synthetic-ada-001";
const config = {
  audience: "hushh-tech-uat",
  developerAppId: "app_hushh-technologies_cd1895ef",
  firebase: {
    projectId: "hushh-pda",
    apiKey: "public-browser-api-key",
  },
};

function token(
  overrides: Record<string, unknown> = {},
  { productBound = true }: { productBound?: boolean } = {}
) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1" })).toString(
    "base64url"
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: UID,
      aud: "hushh-pda",
      iss: "https://securetoken.google.com/hushh-pda",
      iat: NOW_SECONDS - 60,
      auth_time: NOW_SECONDS - 120,
      exp: NOW_SECONDS + 3600,
      ...(productBound
        ? {
            product_client: "hushh-tech",
            product_client_app_id: config.developerAppId,
            product_audience: config.audience,
            product_launch_authorization_id: `htla_${"a".repeat(32)}`,
            product_launch_valid_after_ms: (NOW_SECONDS - 1000) * 1000,
          }
        : {}),
      ...overrides,
    })
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

const lookupResponse = (validSince = NOW_SECONDS - 1000) => ({
  ok: true,
  status: 200,
  json: async () => ({ users: [{ localId: UID, validSince: String(validSince) }] }),
});

describe("Hushh Research Firebase verification", () => {
  it("uses Firebase lookup only for an exact Research product-bound token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(lookupResponse());
    const idToken = token();

    await expect(
      verifyHushhResearchFirebaseToken(idToken, config, {
        fetchImpl,
        now: () => NOW_SECONDS * 1000,
      })
    ).resolves.toEqual({
      uid: UID,
      authTime: NOW_SECONDS - 120,
      idToken,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=public-browser-api-key",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idToken }),
      })
    );

    fetchImpl.mockClear();
    await expect(
      verifyHushhResearchFirebaseToken(token({ aud: "another-project" }), config, {
        fetchImpl,
        now: () => NOW_SECONDS * 1000,
      })
    ).rejects.toMatchObject({ state: "UNAUTHENTICATED", statusCode: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(
      verifyHushhResearchFirebaseToken(
        token({}, { productBound: false }),
        config,
        { fetchImpl, now: () => NOW_SECONDS * 1000 }
      )
    ).rejects.toMatchObject({ state: "UNAUTHENTICATED", statusCode: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();

    for (const claims of [
      { product_client: "hushh-one" },
      { product_client_app_id: "app_other" },
      { product_audience: "another-audience" },
      { product_launch_authorization_id: "" },
      { product_launch_valid_after_ms: -1 },
      { product_launch_valid_after_ms: 1.5 },
      { product_launch_valid_after_ms: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(
        verifyHushhResearchFirebaseToken(token(claims), config, {
          fetchImpl,
          now: () => NOW_SECONDS * 1000,
        })
      ).rejects.toMatchObject({ state: "UNAUTHENTICATED", statusCode: 401 });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("fails closed for revoked, disabled, invalid, and unavailable sessions", async () => {
    await expect(
      verifyHushhResearchFirebaseToken(token(), config, {
        fetchImpl: vi.fn().mockResolvedValue(lookupResponse(NOW_SECONDS)),
        now: () => NOW_SECONDS * 1000,
      })
    ).rejects.toMatchObject({ state: "UNAUTHENTICATED" });

    await expect(
      verifyHushhResearchFirebaseToken(token(), config, {
        fetchImpl: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ users: [{ localId: UID, disabled: true }] }),
        }),
        now: () => NOW_SECONDS * 1000,
      })
    ).rejects.toBeInstanceOf(HushhResearchAuthError);

    await expect(
      verifyHushhResearchFirebaseToken(token(), config, {
        fetchImpl: vi.fn().mockRejectedValue(new Error("network")),
        now: () => NOW_SECONDS * 1000,
      })
    ).rejects.toMatchObject({
      state: "UPSTREAM_UNAVAILABLE",
      statusCode: 503,
    });
  });
});
