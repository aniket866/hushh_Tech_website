import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const uat = readFileSync(".github/workflows/deploy-uat.yml", "utf8");
const production = readFileSync(".github/workflows/deploy-prod.yml", "utf8");

describe("GCP legacy-function gateway deployment contract", () => {
  it("enables only the exact UAT investor service target", () => {
    expect(uat).toContain('HUSHH_TECH_GCP_FUNCTIONS_ENABLED: "true"');
    expect(uat).toContain(
      "HUSHH_TECH_INVESTOR_API_URL: https://hushh-tech-investor-api-175298245599.us-central1.run.app",
    );
    expect(uat).toContain(
      "HUSHH_TECH_GCP_FUNCTIONS_ENABLED=${HUSHH_TECH_GCP_FUNCTIONS_ENABLED}",
    );
    expect(uat).toContain(
      "HUSHH_TECH_INVESTOR_API_URL=${HUSHH_TECH_INVESTOR_API_URL}",
    );
    expect(uat).toContain(
      "--service-account=hushh-tech-web-uat@hushh-tech-uat.iam.gserviceaccount.com",
    );
  });

  it("does not enable the compatibility gateway in production", () => {
    expect(production).not.toContain("HUSHH_TECH_GCP_FUNCTIONS_ENABLED=true");
    expect(production).not.toContain(
      "hushh-tech-investor-api-175298245599.us-central1.run.app",
    );
  });
});
