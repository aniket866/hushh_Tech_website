import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("default-off notification and write candidate source pins", () => {
  it("binds every candidate to the exact checked-in function source", async () => {
    const matrix = JSON.parse(
      await readFile(
        new URL(
          "../cloud-run/hushh-tech-app-services/registry/candidates.notify-write-batch.v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    expect(matrix.functions).toHaveLength(8);
    for (const row of matrix.functions) {
      const source = await readFile(
        new URL(`../supabase/functions/${row.slug}/index.ts`, import.meta.url),
      );
      expect(createHash("sha256").update(source).digest("hex")).toBe(
        row.source_sha256,
      );
    }
  });
});
