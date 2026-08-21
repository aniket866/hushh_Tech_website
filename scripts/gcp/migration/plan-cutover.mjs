#!/usr/bin/env node

import { buildCdcPlan } from "./cdc-plan.mjs";
import {
  MigrationContractError,
  boundaryFromCliArgs,
  parseCliArgs,
  safeJsonForStdout,
} from "./contract.mjs";
import { buildSourceInventoryReadOnlySql } from "./source-inventory.mjs";

function isExplicitTrue(value) {
  return value === true || value === "true";
}

try {
  const args = parseCliArgs(process.argv.slice(2));
  const boundary = boundaryFromCliArgs(args);
  const output = {
    version: 1,
    mode: "DRY_RUN",
    boundary,
    sourceInventoryReadOnlySql: buildSourceInventoryReadOnlySql(),
    cdc: buildCdcPlan(boundary, {
      dryRun: true,
      sourceDirectConnectivityVerified:
        isExplicitTrue(args["source-direct-connectivity-verified"]),
      sourceIpv4AddonVerified: isExplicitTrue(args["source-ipv4-addon-verified"]),
      targetOutgoingIpMode: args["target-outgoing-ip-mode"],
      targetOutgoingIpVerified: isExplicitTrue(args["target-outgoing-ip-verified"]),
      connectivityEvidenceHash: args["connectivity-evidence-hash"],
    }),
  };
  process.stdout.write(safeJsonForStdout(output));
} catch (error) {
  if (error instanceof MigrationContractError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write("UNEXPECTED_ERROR: Migration planning failed closed.\n");
    process.exitCode = 1;
  }
}
