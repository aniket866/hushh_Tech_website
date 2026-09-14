import { describe, expect, it } from "vitest";

import { findDeadModules } from "../scripts/ci/report-dead-modules.mjs";

/**
 * The dead-module report.
 *
 * Every case here is a shape that made the September 2026 sweep's first pass wrong. The report is
 * advisory precisely because these are heuristics, but it is worth only as much as its precision:
 * a report that cries wolf is one nobody reads, and the live modules below are exactly the ones an
 * import-only grep calls dead.
 */

const corpus = (entries: Record<string, string>) => Object.entries(entries);

describe("finding modules nothing reaches", () => {
  it("reports a module with no importer", () => {
    const dead = findDeadModules({
      modules: ["src/components/PaywallOverlay.tsx"],
      corpus: corpus({ "src/App.tsx": "import Home from './pages/Home';" }),
    });
    expect(dead).toEqual(["src/components/PaywallOverlay.tsx"]);
  });

  it("does not report a module a substring of whose name is imported", () => {
    // `Hero.tsx` was genuinely dead, but `HushhIDHero` is not — and an unanchored search for
    // "Hero" cannot tell them apart, so it clears the wrong file.
    const dead = findDeadModules({
      modules: ["src/components/HushhIDHero.tsx"],
      corpus: corpus({ "src/App.tsx": "import HushhIDHero from './components/HushhIDHero';" }),
    });
    expect(dead).toEqual([]);
  });

  it("still reports a module whose name is only a substring of another import", () => {
    const dead = findDeadModules({
      modules: ["src/components/Hero.tsx"],
      corpus: corpus({ "src/App.tsx": "import X from './components/HushhIDHero';" }),
    });
    expect(dead).toEqual(["src/components/Hero.tsx"]);
  });

  it("treats a test that reads the file by path as a reference", () => {
    // tests/investorJourneyContract.test.ts reads profilePage.tsx and asserts on its contents.
    // Nothing imports it, and deleting it breaks a passing test.
    const dead = findDeadModules({
      modules: ["src/components/profile/profilePage.tsx"],
      corpus: corpus({
        "tests/investorJourneyContract.test.ts": 'read("src/components/profile/profilePage.tsx")',
      }),
    });
    expect(dead).toEqual([]);
  });

  it("treats a frozen migration manifest as a reference", () => {
    // The Supabase inventory is frozen against the tree it recorded. A module named there is
    // evidence, whether or not any code imports it.
    const dead = findDeadModules({
      modules: ["src/services/storageBuckets.ts"],
      corpus: corpus({
        "migration/manifests/supabase-retirement.v1.json": '{"source":"src/services/storageBuckets.ts"}',
      }),
    });
    expect(dead).toEqual([]);
  });

  it("counts a lazy dynamic import", () => {
    const dead = findDeadModules({
      modules: ["src/pages/Heavy.tsx"],
      corpus: corpus({ "src/App.tsx": "const P = lazy(() => import('./pages/Heavy'));" }),
    });
    expect(dead).toEqual([]);
  });

  it("does not count a module importing itself", () => {
    const dead = findDeadModules({
      modules: ["src/components/Lonely.tsx"],
      corpus: corpus({ "src/components/Lonely.tsx": "export { default } from './Lonely';" }),
    });
    expect(dead).toEqual(["src/components/Lonely.tsx"]);
  });
});
