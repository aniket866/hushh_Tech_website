import { describe, expect, it } from "vitest";

import { firebaseUserToSessionUser } from "../src/services/gcpBackend/client";

const firebaseUser = {
  uid: "firebase-user-123",
  email: "admin@example.test",
  phoneNumber: null,
  displayName: "Admin",
  photoURL: null,
  refreshToken: "refresh-token",
  isAnonymous: false,
  providerData: [
    {
      providerId: "google.com",
      uid: "google-user-123",
      email: "admin@example.test",
      displayName: "Admin",
      photoURL: null,
    },
  ],
  metadata: {
    creationTime: "2026-08-22T00:00:00.000Z",
    lastRefreshTime: "2026-08-22T00:01:00.000Z",
    lastSignInTime: "2026-08-22T00:01:00.000Z",
  },
} as Parameters<typeof firebaseUserToSessionUser>[0];

describe("GCP backend Firebase auth facade", () => {
  it.each([
    [true, true],
    ["true", false],
    [1, false],
    [undefined, false],
  ])(
    "maps token.claims.fund_admin=%p to app_metadata.fund_admin=%p",
    (claim, expected) => {
      const claims = claim === undefined ? {} : { fund_admin: claim };
      const user = firebaseUserToSessionUser(firebaseUser, claims);

      expect(user.app_metadata.fund_admin).toBe(expected);
    },
  );
});
