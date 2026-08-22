import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  PREFLIGHT_IMAGE_REQUIRED_PATHS,
  validatePreflightImageClosure,
} from '../scripts/migration/check-storage-preflight-image-closure.mjs';

const sourceByImagePath = new Map<string, string>([
  ['/app/check-storage-preflight-image-closure.mjs', 'scripts/migration/check-storage-preflight-image-closure.mjs'],
  ['/app/storage-cutover-contract.mjs', 'scripts/migration/storage-cutover-contract.mjs'],
  ['/app/storage-isolated-cutover-contract.mjs', 'scripts/migration/storage-isolated-cutover-contract.mjs'],
  ['/app/storage-live-common.mjs', 'scripts/migration/storage-live-common.mjs'],
  ['/app/storage-live-inventory.mjs', 'scripts/migration/storage-live-inventory.mjs'],
  ['/app/storage-live-policy.mjs', 'scripts/migration/storage-live-policy.mjs'],
  ['/app/storage-preflight-job.mjs', 'scripts/migration/storage-preflight-job.mjs'],
  ['/app/storage-seven-bucket-contract.mjs', 'scripts/migration/storage-seven-bucket-contract.mjs'],
  ['/migration/storage/supabase-storage-copy-policy.candidate.v1.json', 'migration/storage/supabase-storage-copy-policy.candidate.v1.json'],
  ['/migration/storage/supabase-storage-cutover.v1.json', 'migration/storage/supabase-storage-cutover.v1.json'],
  ['/migration/storage/supabase-storage-isolated-cutover-uat.v1.json', 'migration/storage/supabase-storage-isolated-cutover-uat.v1.json'],
  ['/migration/storage/supabase-storage-seven-bucket-uat.activation.v1.json', 'migration/storage/supabase-storage-seven-bucket-uat.activation.v1.json'],
  ['/migration/storage/supabase-storage-seven-bucket-uat.v1.json', 'migration/storage/supabase-storage-seven-bucket-uat.v1.json'],
]);

const temporaryRoots: string[] = [];

const makeClosure = () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-preflight-image-'));
  temporaryRoots.push(root);
  for (const imagePath of PREFLIGHT_IMAGE_REQUIRED_PATHS) {
    const target = join(root, imagePath.slice(1));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(sourceByImagePath.get(imagePath)!, target);
    chmodSync(target, 0o444);
  }
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('storage preflight image closure', () => {
  it('is complete, read-only, and contains no embedded JSON input under /app', () => {
    expect(validatePreflightImageClosure(makeClosure())).toEqual({ requiredFileCount: 13 });
  });

  it.each(PREFLIGHT_IMAGE_REQUIRED_PATHS)('fails closed when %s is missing', (missingPath) => {
    const root = makeClosure();
    rmSync(join(root, missingPath.slice(1)));
    expect(() => validatePreflightImageClosure(root)).toThrow();
  });

  it('rejects a writable runtime module', () => {
    const root = makeClosure();
    chmodSync(join(root, 'app/storage-preflight-job.mjs'), 0o644);
    expect(() => validatePreflightImageClosure(root)).toThrow(/NOT_IMMUTABLE/);
  });
});
