import { describe, expect, it, vi } from "vitest";

vi.mock("../src/resources/config/config", () => ({
  default: {
    GCP_API_BASE_URL: "/api/gcp",
  },
}));

import {
  getGcpBackendRpcUrl,
  getGcpBackendStoragePublicUrl,
  getNdaGenerationUrl,
} from "../src/services/runtime/mainWeb";

describe("main web runtime helpers", () => {
  it("builds RPC URLs from the same-origin GCP backend", () => {
    const rpcUrl = getGcpBackendRpcUrl("check_access_status");

    expect(rpcUrl).toBe("/api/gcp/rest/v1/rpc/check_access_status");
    expect(rpcUrl).not.toContain("supabase");
  });

  it("builds storage URLs from the same-origin GCP backend", () => {
    const storageUrl = getGcpBackendStoragePublicUrl(
      "website",
      "market-updates/example.png"
    );

    expect(storageUrl).toBe(
      "/api/gcp/storage/v1/object/public/website/market-updates/example.png"
    );
    expect(storageUrl).not.toContain("supabase");
  });

  it("keeps the NDA generation service configurable with a Cloud Run default", () => {
    expect(getNdaGenerationUrl()).toContain(
      "hushhtech-nda-generation-53407187172.us-central1.run.app/generate-nda"
    );
  });
});
