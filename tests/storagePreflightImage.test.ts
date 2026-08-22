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
import {
  InCloudStoragePreflightClient,
} from '../scripts/migration/storage-preflight-job.mjs';
import {
  ISOLATED_CUTOVER_CONTRACT,
  isolationDenialConditionExpression,
  isolationExceptionPrincipals,
  isolationTagValueNamespacedName,
} from '../scripts/migration/storage-isolated-cutover-contract.mjs';

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
const targetBucket = 'hushh-tech-cutover-v1-assets-legal-uat';
const targetTagHost = 'us-central1-cloudresourcemanager.googleapis.com';

const mappingFor = (bucketName: string) => {
  const mapping = ISOLATED_CUTOVER_CONTRACT.buckets.find(
    (candidate: Record<string, string>) => candidate.targetBucket === bucketName,
  );
  if (!mapping) throw new Error('test bucket mapping missing');
  return mapping;
};

const tagsFor = (bucketName: string) => {
  const mapping = mappingFor(bucketName);
  return [{
    parent: `//storage.googleapis.com/projects/_/buckets/${bucketName}`,
    tagValue: mapping.tagValueResource,
    tagValueNamespacedName: isolationTagValueNamespacedName(bucketName),
  }];
};

const exactDenyPolicy = () => ({
  kind: 'DenyPolicy',
  displayName: ISOLATED_CUTOVER_CONTRACT.denyPolicyDisplayName,
  rules: ISOLATED_CUTOVER_CONTRACT.buckets.map(
    (mapping: Record<string, string>) => ({
      denyRule: {
        deniedPermissions: [...ISOLATED_CUTOVER_CONTRACT.deniedPermissions],
        deniedPrincipals: [...ISOLATED_CUTOVER_CONTRACT.deniedPrincipals],
        exceptionPrincipals: isolationExceptionPrincipals(mapping.targetBucket),
        denialCondition: {
          title: `Isolate ${mapping.targetBucket}`,
          expression: isolationDenialConditionExpression(mapping.targetBucket),
        },
      },
    }),
  ),
});

const providerJson = (
  payload: unknown,
  {
    status = 200,
    url,
    redirected = false,
    includeUrl = true,
    includeRedirected = true,
  }: {
    status?: number;
    url?: unknown;
    redirected?: unknown;
    includeUrl?: boolean;
    includeRedirected?: boolean;
  } = {},
) => {
  const bytes = Buffer.from(JSON.stringify(payload));
  const response: Record<string, unknown> = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-length': String(bytes.length) }),
    body: null,
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
  };
  if (includeUrl) response.url = url;
  if (includeRedirected) response.redirected = redirected;
  return response as unknown as Response;
};

const authorizedClient = (fetchImpl: typeof fetch) => {
  const client = new InCloudStoragePreflightClient({
    fetchImpl,
    inheritedBindings: [],
  });
  client.accessToken = 'read-only-test-token-value';
  return client;
};

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

describe('storage preflight regional tag binding client', () => {
  it('uses the exact US-CENTRAL1 Resource Manager endpoint and frozen bucket parent', async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.hostname === targetTagHost) {
        return providerJson(
          { tagBindings: tagsFor(targetBucket) },
          { url: url.href },
        );
      }
      if (url.hostname === 'iam.googleapis.com') {
        return providerJson(exactDenyPolicy(), { url: url.href });
      }
      throw new Error(`unexpected test endpoint: ${url.hostname}`);
    };
    const client = authorizedClient(fetchImpl as typeof fetch);

    await expect(client.inspectIsolation(targetBucket, [])).resolves.toMatchObject({
      isolationSafe: true,
      inheritedAccessNeutralized: true,
      tagValueNamespacedName: isolationTagValueNamespacedName(targetBucket),
    });

    const tagRequest = requests.find(({ url }) => url.hostname === targetTagHost);
    expect(tagRequest).toBeDefined();
    expect(tagRequest!.url.origin).toBe(`https://${targetTagHost}`);
    expect(tagRequest!.url.pathname).toBe('/v3/tagBindings');
    expect([...tagRequest!.url.searchParams.keys()].sort()).toEqual(['pageSize', 'parent']);
    expect(tagRequest!.url.searchParams.get('pageSize')).toBe('300');
    expect(tagRequest!.url.searchParams.get('parent')).toBe(
      `//storage.googleapis.com/projects/_/buckets/${targetBucket}`,
    );
    expect(tagRequest!.init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it.each([
    'https://cloudresourcemanager.googleapis.com/v3/tagBindings',
    'https://us-east1-cloudresourcemanager.googleapis.com/v3/tagBindings',
  ])('blocks global or wrong-region Resource Manager endpoint %s', async (endpoint) => {
    let called = false;
    const client = authorizedClient((async () => {
      called = true;
      return providerJson({});
    }) as typeof fetch);
    await expect(client.getJson(endpoint, 'TARGET_TAG_BINDING_READ_FAILED')).rejects.toMatchObject({
      code: 'PREFLIGHT_JOB_ENDPOINT_BLOCKED',
    });
    expect(called).toBe(false);
  });

  it.each([
    {
      mutation: { projectNumber: '999999999999' },
      code: 'TARGET_BUCKET_PROJECT_DRIFT',
    },
    {
      mutation: { location: 'US' },
      code: 'TARGET_LOCATION_DRIFT',
    },
    {
      mutation: { id: 'cross-bucket', name: 'cross-bucket' },
      code: 'TARGET_BUCKET_IDENTITY_DRIFT',
    },
  ])('rejects target bucket scope drift with $code', async ({ mutation, code }) => {
    const client = authorizedClient((async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      return providerJson({
        id: targetBucket,
        name: targetBucket,
        projectNumber: ISOLATED_CUTOVER_CONTRACT.projectNumber,
        location: ISOLATED_CUTOVER_CONTRACT.location,
        ...mutation,
      }, { url: url.href });
    }) as typeof fetch);
    await expect(client.getBucket(targetBucket)).rejects.toMatchObject({ code });
  });

  it('accepts only the exact frozen bucket identity, project, and regional location', async () => {
    const exactBucket = {
      id: targetBucket,
      name: targetBucket,
      projectNumber: ISOLATED_CUTOVER_CONTRACT.projectNumber,
      location: ISOLATED_CUTOVER_CONTRACT.location,
    };
    const client = authorizedClient((async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      return providerJson(exactBucket, { url: url.href });
    }) as typeof fetch);
    await expect(client.getBucket(targetBucket)).resolves.toEqual(exactBucket);
  });

  it('blocks an unknown bucket before credential or provider access', async () => {
    let metadataCredentialFetchCount = 0;
    let providerFetchCount = 0;
    const client = new InCloudStoragePreflightClient({
      fetchImpl: (async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        if (url.hostname === 'metadata.google.internal') {
          metadataCredentialFetchCount += 1;
        } else {
          providerFetchCount += 1;
        }
        throw new Error('unknown bucket must stop before any fetch');
      }) as typeof fetch,
      inheritedBindings: [],
    });
    await expect(client.inspectIsolation('hushh-tech-cutover-v1-other-uat', [])).rejects.toMatchObject({
      code: 'PREFLIGHT_JOB_TARGET_BUCKET_BLOCKED',
    });
    expect(metadataCredentialFetchCount).toBe(0);
    expect(providerFetchCount).toBe(0);
  });

  it.each([
    {
      label: 'redirect flag',
      redirected: true,
      responseUrl: 'EXACT_REQUEST_URL',
      includeUrl: true,
      includeRedirected: true,
    },
    {
      label: 'rewritten URL',
      redirected: false,
      responseUrl: 'https://cloudresourcemanager.googleapis.com/v3/tagBindings',
      includeUrl: true,
      includeRedirected: true,
    },
    {
      label: 'empty URL',
      redirected: false,
      responseUrl: '',
      includeUrl: true,
      includeRedirected: true,
    },
    {
      label: 'missing URL',
      redirected: false,
      responseUrl: undefined,
      includeUrl: false,
      includeRedirected: true,
    },
    {
      label: 'non-string URL',
      redirected: false,
      responseUrl: 42,
      includeUrl: true,
      includeRedirected: true,
    },
    {
      label: 'missing redirect state',
      redirected: undefined,
      responseUrl: 'EXACT_REQUEST_URL',
      includeUrl: true,
      includeRedirected: false,
    },
    {
      label: 'non-boolean redirect state',
      redirected: 'false',
      responseUrl: 'EXACT_REQUEST_URL',
      includeUrl: true,
      includeRedirected: true,
    },
  ])('rejects TagBindings response endpoint drift: $label', async ({
    redirected,
    responseUrl,
    includeUrl,
    includeRedirected,
  }) => {
    const client = authorizedClient((async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === targetTagHost) {
        return providerJson(
          { tagBindings: tagsFor(targetBucket) },
          {
            redirected,
            url: responseUrl === 'EXACT_REQUEST_URL' ? url.href : responseUrl,
            includeUrl,
            includeRedirected,
          },
        );
      }
      throw new Error('redirect test must stop before another request');
    }) as typeof fetch);
    await expect(client.inspectIsolation(targetBucket, [])).rejects.toMatchObject({
      code: 'TARGET_TAG_BINDING_READ_FAILED',
    });
  });

  it.each([
    { tagBindings: tagsFor(targetBucket), nextPageToken: 'continuation-token' },
    { tagBindings: tagsFor(targetBucket), nextPageToken: '' },
    { tagBindings: tagsFor(targetBucket), unexpectedProviderField: true },
    { tagBindings: null },
  ])('rejects paginated or schema-drifted regional responses', async (payload) => {
    const client = authorizedClient((async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === targetTagHost) {
        return providerJson(payload, { url: url.href });
      }
      throw new Error('pagination test must stop before another request');
    }) as typeof fetch);
    await expect(client.inspectIsolation(targetBucket, [])).rejects.toMatchObject({
      code: 'TARGET_TAG_BINDING_READ_FAILED',
    });
  });
});
