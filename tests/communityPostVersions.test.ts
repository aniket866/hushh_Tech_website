import { describe, it, expect } from "vitest";
import {
  buildVersionIndex,
  comparePublishedAtDesc,
  decorateVersions,
  normalizePublishedAt,
  selectLatestVersions,
} from "../api/community/postVersions.js";

const post = (slug: string, publishedAt: string, extra: Record<string, unknown> = {}) => ({
  slug,
  title: slug,
  publishedAt,
  ...extra,
});

describe("normalizePublishedAt", () => {
  it("passes ISO dates through and zero-pads short components", () => {
    expect(normalizePublishedAt("2026-03-01")).toBe("2026-03-01");
    expect(normalizePublishedAt("2025-2-5")).toBe("2025-02-05");
  });

  it("reads slash dates day-first, matching parseDate in the UI", () => {
    expect(normalizePublishedAt("21/07/2025")).toBe("2025-07-21");
    expect(normalizePublishedAt("15/4/2025")).toBe("2025-04-15");
    expect(normalizePublishedAt("15/07/2025 00:50")).toBe("2025-07-15");
  });

  it("returns empty for anything it cannot parse", () => {
    for (const value of ["", "   ", "not a date", "32/13/2025", null, undefined, 20250101]) {
      expect(normalizePublishedAt(value as string)).toBe("");
    }
  });
});

describe("comparePublishedAtDesc", () => {
  it("orders newest first across both date formats", () => {
    const ordered = [
      post("old-slash", "21/07/2025"),
      post("newest", "2026-03-01"),
      post("middle", "2025-12-06"),
    ].sort(comparePublishedAtDesc);

    expect(ordered.map((p) => p.slug)).toEqual(["newest", "middle", "old-slash"]);
  });

  it("sinks undated posts instead of floating them to the top", () => {
    // Raw localeCompare put "21/07/2025" above every "2026-…" value, which is how
    // a July 2025 post led the live API response.
    const ordered = [post("undated", ""), post("dated", "2026-01-01")].sort(comparePublishedAtDesc);
    expect(ordered.map((p) => p.slug)).toEqual(["dated", "undated"]);
  });
});

describe("selectLatestVersions", () => {
  it("keeps every post when no family is declared", () => {
    const posts = [post("a", "2026-01-01"), post("b", "2025-01-01")];
    expect(selectLatestVersions(posts)).toHaveLength(2);
  });

  it("collapses a family to its highest docVersion", () => {
    const posts = [
      post("investment-strategies/sell-the-wall", "2025-02-10", { docFamily: "sell-the-wall", docVersion: 1 }),
      post("general/sell-the-wall-featured", "2025-11-30", { docFamily: "sell-the-wall", docVersion: 3 }),
      post("financial-strategies/sell-the-wall-masterclass", "2025-01-25", {
        docFamily: "sell-the-wall",
        docVersion: 2,
      }),
    ];

    expect(selectLatestVersions(posts).map((p) => p.slug)).toEqual([
      "general/sell-the-wall-featured",
    ]);
  });

  it("falls back to the latest date when versions tie", () => {
    const posts = [
      post("older", "2025-01-01", { docFamily: "prospectus" }),
      post("newer", "2026-03-01", { docFamily: "prospectus" }),
    ];
    expect(selectLatestVersions(posts).map((p) => p.slug)).toEqual(["newer"]);
  });

  it("preserves input order for the survivors", () => {
    const posts = [
      post("keep-1", "2026-01-01"),
      post("drop", "2024-01-01", { docFamily: "f", docVersion: 1 }),
      post("keep-2", "2025-01-01", { docFamily: "f", docVersion: 2 }),
      post("keep-3", "2023-01-01"),
    ];
    expect(selectLatestVersions(posts).map((p) => p.slug)).toEqual(["keep-1", "keep-2", "keep-3"]);
  });

  it("treats a blank or whitespace docFamily as untagged", () => {
    const posts = [
      post("a", "2026-01-01", { docFamily: "  " }),
      post("b", "2025-01-01", { docFamily: "" }),
    ];
    expect(selectLatestVersions(posts)).toHaveLength(2);
  });

  it("is stable when version and date are both identical", () => {
    const posts = [
      post("first", "2026-01-01", { docFamily: "f" }),
      post("second", "2026-01-01", { docFamily: "f" }),
    ];
    expect(selectLatestVersions(posts).map((p) => p.slug)).toEqual(["first"]);
  });

  it("tolerates empty, null and non-array input", () => {
    expect(selectLatestVersions([])).toEqual([]);
    expect(selectLatestVersions(null as never)).toEqual([]);
    expect(selectLatestVersions([null, undefined] as never)).toEqual([]);
  });
});

describe("decorateVersions", () => {
  it("points a superseded post at its current edition", () => {
    const posts = [
      post("nda/investor-prospectus", "2025-02-12", { docFamily: "prospectus", docVersion: 1 }),
      post("fund-documents/investment-prospectus", "2026-03-01", {
        docFamily: "prospectus",
        docVersion: 2,
      }),
    ];

    const [superseded, current] = decorateVersions(posts);
    expect(superseded.isLatestVersion).toBe(false);
    expect(superseded.supersededBy).toBe("fund-documents/investment-prospectus");
    expect(superseded.supersededByTitle).toBe("fund-documents/investment-prospectus");
    expect(current.isLatestVersion).toBe(true);
    expect(current.supersededBy).toBe("");
  });

  it("keeps superseded posts in the list so their pages still resolve", () => {
    const posts = [
      post("v1", "2025-01-01", { docFamily: "f", docVersion: 1 }),
      post("v2", "2026-01-01", { docFamily: "f", docVersion: 2 }),
    ];
    expect(decorateVersions(posts).map((p) => p.slug)).toEqual(["v1", "v2"]);
  });

  it("does not mutate the input posts", () => {
    const original = post("v1", "2025-01-01", { docFamily: "f", docVersion: 1 });
    decorateVersions([original, post("v2", "2026-01-01", { docFamily: "f", docVersion: 2 })]);
    expect(original).not.toHaveProperty("isLatestVersion");
  });
});

describe("buildVersionIndex", () => {
  it("reports the current edition for every slug in a family", () => {
    const index = buildVersionIndex([
      post("a", "2025-01-01", { docFamily: "f", docVersion: 1 }),
      post("b", "2026-01-01", { docFamily: "f", docVersion: 2 }),
    ]);

    expect(index.get("a")).toMatchObject({ isLatest: false, latestSlug: "b", version: 1 });
    expect(index.get("b")).toMatchObject({ isLatest: true, latestSlug: "b", version: 2 });
  });
});
