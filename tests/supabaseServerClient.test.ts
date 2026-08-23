import { describe, expect, it } from "vitest";

import { createGcpServerClient } from "../api/shared/gcpServerClient.js";

describe("GCP server client helper", () => {
  it("exposes the bounded data, auth, and storage compatibility surface", () => {
    const client = createGcpServerClient();

    expect(client.from).toEqual(expect.any(Function));
    expect(client.rpc).toEqual(expect.any(Function));
    expect(client.auth.getUser).toEqual(expect.any(Function));
    expect(client.auth.admin.deleteUser).toEqual(expect.any(Function));
    expect(client.auth.admin.listUsers).toEqual(expect.any(Function));
    expect(client.storage.from).toEqual(expect.any(Function));
    expect(client).not.toHaveProperty("realtime");
  });

  it("returns same-origin storage URLs without a provider credential", () => {
    const client = createGcpServerClient();
    const result = client.storage
      .from("profile-images")
      .getPublicUrl("users/user-a/avatar image.png");

    expect(result).toEqual({
      data: {
        publicUrl:
          "/api/gcp/storage/profile-images/users/user-a/avatar%20image.png",
      },
    });
  });
});
