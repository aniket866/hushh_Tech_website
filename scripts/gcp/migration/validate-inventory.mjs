#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  MigrationContractError,
  boundaryFromCliArgs,
  parseCliArgs,
  safeJsonForStdout,
} from "./contract.mjs";
import { validateSourceInventory } from "./source-inventory.mjs";

try {
  const args = parseCliArgs(process.argv.slice(2));
  if (typeof args.input !== "string" || args.input.length === 0) {
    throw new MigrationContractError(
      "INPUT_REQUIRED",
      "A sanitized offline inventory file is required."
    );
  }
  const boundary = boundaryFromCliArgs(args);
  const inventory = JSON.parse(readFileSync(args.input, "utf8"));
  const summary = validateSourceInventory(inventory, boundary);
  process.stdout.write(safeJsonForStdout({ ...summary, boundary }));
} catch (error) {
  if (error instanceof MigrationContractError || error instanceof SyntaxError) {
    const code = error instanceof MigrationContractError ? error.code : "INVALID_JSON";
    const message =
      error instanceof MigrationContractError
        ? error.message
        : "The offline inventory is not valid JSON.";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write("INVENTORY_READ_FAILED: Offline inventory validation failed closed.\n");
    process.exitCode = 1;
  }
}
