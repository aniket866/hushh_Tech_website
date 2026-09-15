import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

const publicTextExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);

const walkPublicSource = (relativeDirectory: string): string[] => {
  const absoluteDirectory = path.join(root, relativeDirectory);
  return readdirSync(absoluteDirectory).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry);
    const absolutePath = path.join(root, relativePath);
    if (statSync(absolutePath).isDirectory()) return walkPublicSource(relativePath);
    return publicTextExtensions.has(path.extname(entry)) ? [relativePath] : [];
  });
};

const websiteClaimFiles = [
  ...walkPublicSource("src"),
  path.join("api", "community", "staticPosts.generated.js"),
];

const forbiddenUnsupportedClaims = [
  /\bSEC[ -]?registered\b/i,
  /\bSEC[ -]?compliant\b/i,
  /\bregistered hedge fund\b/i,
  /\bregistered with relevant U\.S\. and UAE financial authorities\b/i,
  /\bregulatory approval ensures\b/i,
];

describe("public regulatory claim contract", () => {
  it("does not claim SEC registration, compliance, or regulatory approval", () => {
    const violations = websiteClaimFiles.flatMap((relativePath) => {
      const source = readFileSync(path.join(root, relativePath), "utf8");
      return forbiddenUnsupportedClaims
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relativePath}: ${pattern.source}`);
    });

    expect(violations).toEqual([]);
  });

  it("uses neutral offering and regulator language on critical investor surfaces", () => {
    const footer = readFileSync(path.join(root, "src/components/Footer.tsx"), "utf8");
    const onboarding = readFileSync(
      path.join(root, "src/pages/onboarding/step-7/ui.tsx"),
      "utf8",
    );
    const fundPage = readFileSync(
      path.join(root, "src/pages/discover-fund-a/logic.ts"),
      "utf8",
    );

    expect(footer).toContain("No regulator has approved or endorsed any investment described here.");
    expect(onboarding).toContain("Participation is subject to eligibility verification");
    expect(fundPage).toContain("No regulatory approval is represented.");
  });
});
