import assert from "node:assert/strict";
import test from "node:test";

import { classifyObjects, compareBaseline, loadBaseline } from "../src/baseline.js";

test("loads the approved UAT baseline contract", () => {
  const baseline = loadBaseline();
  assert.equal(baseline.target.project, "hushh-tech-uat");
  assert.equal(baseline.target.database, "hushh_tech_app");
  assert.equal(
    baseline.sourceExpectedSha256,
    "a924487ab2660d2f7aa9226111a53de6539c590b52db4b2f2971bebc1ef774618",
  );
});

test("classifies an exact catalog match as attested", () => {
  const baseline = loadBaseline();
  const result = compareBaseline(baseline.expectedCatalog, baseline);
  assert.equal(result.status, "ATTESTED");
  assert.equal(result.drifted.length, 0);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, []);
});

test("reports catalog drift without converting it into a pass", () => {
  const baseline = loadBaseline();
  const observed = { ...baseline.expectedCatalog, publicTables: 71 };
  const result = compareBaseline(observed, baseline);
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.drifted, [{ key: "publicTables", expected: 70, observed: 71 }]);
});

test("classifies expected, changed, missing, and unexpected objects", () => {
  const result = classifyObjects(
    [
      { name: "users", columns: ["id"] },
      { name: "nda_signatures", columns: ["id", "signed_at"] },
    ],
    [
      { name: "users", columns: ["id"] },
      { name: "nda_signatures", columns: ["id"] },
      { name: "unexpected", columns: ["id"] },
    ],
  );
  assert.deepEqual(result, {
    matched: ["users"],
    missing: [],
    drifted: ["nda_signatures"],
    unexpected: ["unexpected"],
  });
});
