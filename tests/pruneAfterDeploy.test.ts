import { describe, expect, it } from "vitest";

import { selectPrunable } from "../scripts/gcp/registry/prune-after-deploy.mjs";

/**
 * A pruner is a rollback floor. Every case here is about the images it must refuse to delete —
 * deleting one is silent until the day someone needs to roll back, which is the worst day to find
 * out.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-12T00:00:00Z");

const image = (digest: string, ageDays: number, tags: string[] = []) => ({
  name: `projects/p/locations/l/repositories/r/packages/hushh-tech-website/versions/sha256:${digest}`,
  createTime: new Date(NOW - ageDays * DAY).toISOString(),
  tags,
});

const opts = { now: NOW, keepDays: 30, keepRecent: 3 };

describe("selecting images to prune", () => {
  it("never deletes an image a revision still references", () => {
    // Not just the serving revision: every revision that exists is somebody's rollback target.
    const versions = [image("aaa", 200), image("bbb", 200), image("ccc", 200), image("ddd", 200)];
    const inUse = new Set(["sha256:aaa"]);
    const names = selectPrunable(versions, inUse, opts).map((v) => v.name);
    expect(names.some((n) => n.endsWith("sha256:aaa"))).toBe(false);
  });

  it("never deletes a tagged image", () => {
    // A tag means something names it, and we do not know what.
    const versions = [
      image("aaa", 200, ["build-d8063aa3"]),
      image("bbb", 200),
      image("ccc", 200),
      image("ddd", 200),
      image("eee", 200),
    ];
    const names = selectPrunable(versions, new Set(), opts).map((v) => v.name);
    expect(names.some((n) => n.endsWith("sha256:aaa"))).toBe(false);
  });

  it("never deletes anything inside the keep window", () => {
    const versions = [image("aaa", 29), image("bbb", 31), image("ccc", 200), image("ddd", 200)];
    const names = selectPrunable(versions, new Set(), opts).map((v) => v.name);
    expect(names.some((n) => n.endsWith("sha256:aaa"))).toBe(false);
  });

  it("keeps the newest few whatever their age", () => {
    // A quiet fortnight must not leave the repository one image deep.
    const versions = [image("aaa", 400), image("bbb", 401), image("ccc", 402), image("ddd", 403)];
    const pruned = selectPrunable(versions, new Set(), opts);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].name).toContain("sha256:ddd");
  });

  it("deletes only what is unreferenced, untagged and past the window", () => {
    // Newest first, with keepRecent = 3: fresh, newer-1, newer-2 are the protected three. Note
    // that `fresh` consumes one of those slots purely by being recent, which pushes `older-3` out
    // of the recency guard and leaves it to be judged on the other three rules alone.
    const versions = [
      image("fresh", 2),
      image("newer-1", 100),
      image("newer-2", 101),
      image("older-3", 102),
      image("in-use", 300),
      image("tagged", 301, ["latest"]),
      image("stale", 302),
    ];
    const pruned = selectPrunable(versions, new Set(["sha256:in-use"]), opts).map((v) => v.name);
    expect(pruned.map((n) => n.split(":").pop())).toEqual(["older-3", "stale"]);
  });

  it("deletes nothing when every image is spoken for", () => {
    const versions = [image("aaa", 900), image("bbb", 901)];
    const inUse = new Set(["sha256:aaa", "sha256:bbb"]);
    expect(selectPrunable(versions, inUse, opts)).toEqual([]);
  });

  it("deletes nothing from an empty repository", () => {
    expect(selectPrunable([], new Set(), opts)).toEqual([]);
  });
});
