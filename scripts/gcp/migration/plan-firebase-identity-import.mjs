#!/usr/bin/env node

import { realpathSync } from "node:fs";

import {
  MigrationContractError,
  boundaryFromCliArgs,
  parseCliArgs,
  safeJsonForStdout,
} from "./contract.mjs";
import {
  buildFirebaseIdentityImportDryRunPlan,
  firebaseIdentityImportDryRunSummary,
} from "./firebase-import-plan.mjs";
import { buildIdentityMappingPlan } from "./identity-mapping.mjs";
import { readProtectedJsonFile } from "./protected-json-input.mjs";

const ALLOWED_ARGUMENTS = new Set([
  "environment",
  "source-project-ref",
  "source-database",
  "target-project",
  "target-region",
  "target-instance",
  "target-database",
  "postgres-major",
  "dry-run",
  "execute",
  "apply",
  "inventory",
  "firebase",
  "unclaimed",
  "calendar",
  "relogin-epoch",
]);
const MAX_INPUT_BYTES = Object.freeze({
  inventory: 64 * 1024 * 1024,
  firebase: 32 * 1024 * 1024,
  unclaimed: 4 * 1024 * 1024,
  calendar: 8 * 1024 * 1024,
});
const REPOSITORY_ROOT = realpathSync(new URL("../../../", import.meta.url));

function fail(code, message) {
  throw new MigrationContractError(code, message);
}

function assertArguments(args) {
  for (const name of Object.keys(args)) {
    if (!ALLOWED_ARGUMENTS.has(name)) {
      fail("INVALID_ARGUMENT", "The Firebase dry-run planner received an unsupported argument.");
    }
  }
  if (!(args["dry-run"] === true || args["dry-run"] === "true")) {
    fail(
      "DRY_RUN_FLAG_REQUIRED",
      "The Firebase identity planner requires an explicit --dry-run flag."
    );
  }
}

try {
  const args = parseCliArgs(process.argv.slice(2));
  const boundary = boundaryFromCliArgs(args);
  assertArguments(args);
  const inventory = readProtectedJsonFile({
    path: args.inventory,
    label: "Sanitized inventory",
    maximumBytes: MAX_INPUT_BYTES.inventory,
    repositoryRoot: REPOSITORY_ROOT,
  });
  const firebaseAuthority = readProtectedJsonFile({
    path: args.firebase,
    label: "Firebase provider index",
    maximumBytes: MAX_INPUT_BYTES.firebase,
    repositoryRoot: REPOSITORY_ROOT,
  });
  const unclaimedLegacyPrincipals = readProtectedJsonFile({
    path: args.unclaimed,
    label: "Unclaimed principal",
    maximumBytes: MAX_INPUT_BYTES.unclaimed,
    repositoryRoot: REPOSITORY_ROOT,
  });
  const calendarEvidence = readProtectedJsonFile({
    path: args.calendar,
    label: "Calendar reconnect evidence",
    maximumBytes: MAX_INPUT_BYTES.calendar,
    repositoryRoot: REPOSITORY_ROOT,
  });
  const mappingPlan = buildIdentityMappingPlan({
    inventory,
    boundary,
    firebaseAuthority,
    unclaimedLegacyPrincipals,
  });
  const plan = buildFirebaseIdentityImportDryRunPlan({
    mappingPlan,
    boundary,
    firebaseAuthority,
    calendarEvidence,
    reloginEpoch: args["relogin-epoch"],
    dryRun: true,
  });
  process.stdout.write(safeJsonForStdout(firebaseIdentityImportDryRunSummary(plan)));
} catch (error) {
  if (error instanceof MigrationContractError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(
      "FIREBASE_IDENTITY_DRY_RUN_FAILED: Firebase identity planning failed closed.\n"
    );
    process.exitCode = 1;
  }
}
