import { canonicalHash } from "./canonical-hash.mjs";
import { MigrationContractError, assertDryRunOnly } from "./contract.mjs";

export function createMigrationRunPlan({
  sourceInventoryHash,
  mappingInputHash,
  target,
  dryRun = true,
}) {
  assertDryRunOnly({ dryRun });
  if (!/^[a-f0-9]{64}$/.test(sourceInventoryHash)) {
    throw new MigrationContractError(
      "INVALID_INVENTORY_HASH",
      "sourceInventoryHash must be a SHA-256 digest."
    );
  }
  if (!/^[a-f0-9]{64}$/.test(mappingInputHash)) {
    throw new MigrationContractError(
      "INVALID_MAPPING_HASH",
      "mappingInputHash must be a SHA-256 digest."
    );
  }
  const replayKey = canonicalHash({
    version: 1,
    sourceInventoryHash,
    mappingInputHash,
    target,
  });
  return Object.freeze({
    version: 1,
    mode: "DRY_RUN",
    sourceInventoryHash,
    mappingInputHash,
    replayKey,
    target,
  });
}

export function createCheckpoint({
  replayKey,
  stream,
  sequence,
  cursor,
  rowHashes,
  previousCheckpointHash = null,
}) {
  if (!/^[a-f0-9]{64}$/.test(replayKey)) {
    throw new MigrationContractError("INVALID_REPLAY_KEY", "replayKey must be a SHA-256 digest.");
  }
  if (typeof stream !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/.test(stream)) {
    throw new MigrationContractError("INVALID_STREAM", "Checkpoint stream is invalid.");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new MigrationContractError("INVALID_SEQUENCE", "Checkpoint sequence must be non-negative.");
  }
  if (!Array.isArray(rowHashes) || rowHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new MigrationContractError(
      "INVALID_ROW_HASHES",
      "Checkpoint rows must contain SHA-256 digests only."
    );
  }
  if (previousCheckpointHash !== null && !/^[a-f0-9]{64}$/.test(previousCheckpointHash)) {
    throw new MigrationContractError(
      "INVALID_PREVIOUS_CHECKPOINT",
      "Previous checkpoint must be null or a SHA-256 digest."
    );
  }

  const batchHash = canonicalHash(rowHashes);
  const checkpointPayload = {
    replayKey,
    stream,
    sequence,
    cursor,
    batchHash,
    previousCheckpointHash,
  };
  const checkpointHash = canonicalHash(checkpointPayload);
  return Object.freeze({
    replayKey,
    stream,
    sequence,
    cursor,
    rowCount: rowHashes.length,
    batchHash,
    previousCheckpointHash,
    checkpointHash,
  });
}

export function assertCheckpointIntegrity(checkpoint) {
  if (!checkpoint || !/^[a-f0-9]{64}$/.test(checkpoint.checkpointHash ?? "")) {
    throw new MigrationContractError(
      "INVALID_CHECKPOINT_HASH",
      "Checkpoint must carry a SHA-256 content hash."
    );
  }
  const expectedHash = canonicalHash({
    replayKey: checkpoint.replayKey,
    stream: checkpoint.stream,
    sequence: checkpoint.sequence,
    cursor: checkpoint.cursor,
    batchHash: checkpoint.batchHash,
    previousCheckpointHash: checkpoint.previousCheckpointHash,
  });
  if (checkpoint.checkpointHash !== expectedHash) {
    throw new MigrationContractError(
      "CHECKPOINT_INTEGRITY_FAILURE",
      "Checkpoint content does not match its recorded hash."
    );
  }
  return true;
}

export function assertCheckpointContinuation(previous, next) {
  assertCheckpointIntegrity(previous);
  assertCheckpointIntegrity(next);
  if (next.replayKey !== previous.replayKey || next.stream !== previous.stream) {
    throw new MigrationContractError(
      "CHECKPOINT_STREAM_MISMATCH",
      "Checkpoint replay key and stream must remain unchanged."
    );
  }
  if (next.sequence !== previous.sequence + 1) {
    throw new MigrationContractError(
      "CHECKPOINT_SEQUENCE_MISMATCH",
      "Checkpoint sequence must increase by one."
    );
  }
  if (next.previousCheckpointHash !== previous.checkpointHash) {
    throw new MigrationContractError(
      "CHECKPOINT_HASH_MISMATCH",
      "Checkpoint chain does not reference the previous checkpoint."
    );
  }
  return true;
}
