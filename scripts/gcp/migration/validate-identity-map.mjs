#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  MigrationContractError,
  boundaryFromCliArgs,
  parseCliArgs,
  safeJsonForStdout,
} from "./contract.mjs";
import {
  buildIdentityMappingPlan,
  validateTerminalDispositions,
} from "./identity-mapping.mjs";

function readJsonFile(path, label) {
  if (typeof path !== "string" || path.length === 0) {
    throw new MigrationContractError("INPUT_REQUIRED", `${label} input is required.`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

try {
  const args = parseCliArgs(process.argv.slice(2));
  const boundary = boundaryFromCliArgs(args);
  const inventory = readJsonFile(args.inventory, "Sanitized inventory");
  const firebaseAuthority = readJsonFile(args.firebase, "Firebase authority provider index");
  const unclaimedLegacyPrincipals = readJsonFile(args.unclaimed, "Unclaimed principal");
  const plan = buildIdentityMappingPlan({
    inventory,
    boundary,
    firebaseAuthority,
    unclaimedLegacyPrincipals,
  });
  const counts = validateTerminalDispositions(plan);
  process.stdout.write(
    safeJsonForStdout({
      version: plan.version,
      mode: plan.mode,
      sourceInventoryHash: plan.sourceInventoryHash,
      mappingInputHash: plan.mappingInputHash,
      counts,
      boundary,
    })
  );
} catch (error) {
  if (error instanceof MigrationContractError || error instanceof SyntaxError) {
    const code = error instanceof MigrationContractError ? error.code : "INVALID_JSON";
    const message =
      error instanceof MigrationContractError
        ? error.message
        : "An offline mapping input is not valid JSON.";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write("IDENTITY_PLAN_FAILED: Identity planning failed closed.\n");
    process.exitCode = 1;
  }
}
