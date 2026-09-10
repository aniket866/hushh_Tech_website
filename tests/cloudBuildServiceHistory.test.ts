import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  ancestryRevision,
  prepareRepositoryHistory,
  recoveryRevision,
  requiredRevisions,
} from '../scripts/ci/prepare-repository-history.mjs';

type Step = { id: string; name: string; entrypoint: string; waitFor: string[]; args: string[] };
const pipeline = yaml.load(readFileSync('cloudbuild.ci.yaml', 'utf8')) as { steps: Step[] };
const manifest = JSON.parse(readFileSync(
  'cloud-run/hushh-tech-app-services/registry/candidates.ai-runtime-batch.v1.json', 'utf8',
));

describe('Cloud Build repository provenance inputs', () => {
  it('defines every dependency before its consumers, as Cloud Build requires', () => {
    const earlier = new Set(['-']);
    for (const step of pipeline.steps) {
      for (const prerequisite of step.waitFor) expect(earlier.has(prerequisite)).toBe(true);
      expect(earlier.has(step.id)).toBe(false);
      earlier.add(step.id);
    }
  });
  it('supplies complete tested-HEAD ancestry and the pinned recovery object without switching HEAD', () => {
    const history = pipeline.steps.find((step) => step.id === 'repository-history')!;
    const revision = manifest.source_recovery.revision;
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
    expect(requiredRevisions).toEqual([ancestryRevision, recoveryRevision]);
    expect(recoveryRevision).toBe(revision);
    expect(history.name).toBe('node:20.19.0');
    expect(history.entrypoint).toBe('node');
    expect(history.waitFor).toEqual(['install']);
    expect(history.args).toEqual(['scripts/ci/prepare-repository-history.mjs']);
  });

  it.each(['web', 'service'])('requires history preparation before the unchanged %s gate', (gate) => {
    const step = pipeline.steps.find((entry) => entry.id === gate)!;
    expect(step.waitFor).toEqual(['install', 'repository-history']);
    expect(step.args.slice(0, 1)).toEqual(['-c']);
    const commands = step.args[1].trim().split('\n');
    expect(commands).toEqual(gate === 'web' ? [
      'set -euo pipefail',
      'bash scripts/ci/orchestrate.sh web',
      'node scripts/ci/check-deploy-build-context.mjs',
    ] : [
      'set -euo pipefail',
      'NPM_CONFIG_CACHE=/workspace/.npm-cache bash scripts/ci/orchestrate.sh service',
    ]);
    expect(pipeline.steps.find((entry) => entry.id === 'repository-history')).not.toHaveProperty('allowFailure');
    expect(pipeline.steps.find((entry) => entry.id === 'repository-history')).not.toHaveProperty('allowExitCodes');
  });
});

describe('private repository history preparation', () => {
  const head = 'a'.repeat(40);
  function fixture(shallow = true) {
    let isShallow = shallow;
    const git = vi.fn((args: string[], _env: Record<string, string>) => {
      if (args[0] === 'fetch') isShallow = false;
      if (args[1] === 'HEAD') return head;
      if (args[1] === '--is-shallow-repository') return String(isShallow);
      return '';
    });
    return { git, readToken: vi.fn().mockResolvedValue('test-read-token'), env: { PATH: '/usr/bin', GIT_TRACE: '1', GIT_CURL_VERBOSE: '1' } };
  }

  it('fetches only fixed repository/tested HEAD with a child-only read token and verifies postconditions', async () => {
    const deps = fixture();
    await prepareRepositoryHistory(deps);
    expect(deps.readToken).toHaveBeenCalledTimes(1);
    const fetch = deps.git.mock.calls.find(([args]) => args[0] === 'fetch')!;
    expect(fetch[0]).toEqual(['fetch', '--no-tags', '--unshallow', 'https://github.com/hushh-labs/hushh_Tech_website.git', head]);
    expect(fetch[1].GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from('x-access-token:test-read-token').toString('base64')}`);
    expect(fetch[1].GIT_CONFIG_VALUE_1).toBe('');
    for (const [args, env] of deps.git.mock.calls) {
      expect(args.join(' ')).not.toContain('test-read-token');
      expect(env).not.toHaveProperty('GIT_TRACE');
      expect(env).not.toHaveProperty('GIT_CURL_VERBOSE');
      if (args[0] !== 'fetch') expect(env).not.toHaveProperty('GIT_CONFIG_VALUE_0');
    }
    expect(deps.git.mock.calls.map(([args]) => args)).toEqual([
      ['rev-parse', 'HEAD'], ['rev-parse', '--is-shallow-repository'], fetch[0],
      ['rev-parse', '--is-shallow-repository'],
      ...requiredRevisions.map((revision) => ['cat-file', '-e', `${revision}^{commit}`]),
      ['rev-parse', 'HEAD'],
    ]);
  });

  it('requires no token or fetch for complete local/Actions history', async () => {
    const deps = fixture(false);
    await prepareRepositoryHistory(deps);
    expect(deps.readToken).not.toHaveBeenCalled();
    expect(deps.git.mock.calls.some(([args]) => args[0] === 'fetch')).toBe(false);
  });

  it.each(['', '\ninvalid', undefined])('fails closed on invalid connection token %s', async (token) => {
    const deps = fixture();
    deps.readToken.mockResolvedValue(token);
    await expect(prepareRepositoryHistory(deps)).rejects.toThrow('Repository history preparation failed');
    expect(deps.git.mock.calls.some(([args]) => args[0] === 'fetch')).toBe(false);
  });

  it.each(['provider', 'fetch', 'missing-object', 'incomplete', 'changed-head'])('fails closed without leaking errors: %s', async (failure) => {
    const deps = fixture();
    const normal = deps.git.getMockImplementation()!;
    let headReads = 0;
    if (failure === 'provider') deps.readToken.mockRejectedValue(new Error('secret-provider-header'));
    deps.git.mockImplementation((args, env) => {
      if ((failure === 'fetch' && args[0] === 'fetch') || (failure === 'missing-object' && args[0] === 'cat-file')) throw new Error('secret-provider-header');
      if (failure === 'incomplete' && args[1] === '--is-shallow-repository') return 'true';
      if (failure === 'changed-head' && args[1] === 'HEAD' && headReads++ > 0) return 'b'.repeat(40);
      return normal(args, env);
    });
    await expect(prepareRepositoryHistory(deps)).rejects.toThrow(/^Repository history preparation failed; verify the UAT connection read-token grant and pinned source availability\.$/);
  });
});
