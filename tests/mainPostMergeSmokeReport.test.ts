import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  'continue-on-error'?: boolean;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

const roots: string[] = [];
const suites = ['tests/oauthStart.test.ts', 'tests/authHost.test.ts', 'tests/deleteAccountApiRoute.test.ts', 'tests/publicInvestorProfileApiRoute.test.ts', 'tests/mainWebRuntime.test.ts'];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture({ code = 0, upstream = 'success', report = true, installed = true, blockedPath = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'main-smoke-report-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts/ci'), { recursive: true });
  mkdirSync(path.join(root, 'bin'));
  if (installed) {
    mkdirSync(path.join(root, 'node_modules/vitest'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules/vitest/vitest.mjs'), '// Installed-runner marker for this shell fixture.\n');
  }
  copyFileSync('scripts/ci/run-smoke.sh', path.join(root, 'scripts/ci/run-smoke.sh'));
  const invocation = path.join(root, 'invocation.json');
  writeFileSync(path.join(root, 'bin/npx'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.env.INVOCATION, JSON.stringify({args:process.argv.slice(2), cwd:process.cwd()}));\nprocess.exit(Number(process.env.FIXTURE_EXIT));\n`, { mode: 0o755 });
  if (blockedPath) writeFileSync(path.join(root, 'reports'), 'not a directory');
  const reportPath = path.join(root, 'reports/main-post-merge-smoke.json');
  const result = spawnSync('bash', [path.join(root, 'scripts/ci/run-smoke.sh')], {
    cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, INVOCATION: invocation, FIXTURE_EXIT: String(code), SMOKE_UPSTREAM_STATUS: upstream, SMOKE_REPORT_PATH: report ? reportPath : '' },
  });
  return { root, result, reportPath, invocation };
}

describe('compact smoke diagnostics preserve the blocking contract', () => {
  it.each([0, 17])('writes the original JSON schema and preserves test exit %s', (code) => {
    const { root, result, reportPath, invocation } = fixture({ code });
    expect(result.status).toBe(code);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(Object.keys(report).sort()).toEqual(['generatedAt', 'status', 'suites']);
    expect(report.suites).toEqual(suites);
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
    expect(report.status).toBe(code === 0 ? 'passed' : 'failed');
    expect(JSON.parse(readFileSync(invocation, 'utf8'))).toEqual({ args: ['vitest', 'run', ...suites], cwd: realpathSync(root) });
  });
  it('runs all compact suites after an earlier gate failure but never reports the gate as passed', () => {
    const { result, reportPath, invocation } = fixture({ upstream: 'failure' });
    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(invocation, 'utf8')).args).toEqual(['vitest', 'run', ...suites]);
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).status).toBe('failed');
  });
  it('retains a test failure exit code even when an earlier gate also failed', () => {
    const { result, reportPath } = fixture({ code: 23, upstream: 'failure' });
    expect(result.status).toBe(23);
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).status).toBe('failed');
  });
  it('writes failed diagnostics when dependencies are unavailable without downloading a replacement runner', () => {
    const { result, reportPath, invocation } = fixture({ installed: false });
    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).status).toBe('failed');
    expect(() => readFileSync(invocation)).toThrow();
  });
  it.each([0, 19])('does not require a report path and preserves exit %s for other callers', (code) => {
    expect(fixture({ code, report: false }).result.status).toBe(code);
  });
  it.each([0, 21])('does not hide a report-write failure or replace original failure %s', (code) => {
    expect(fixture({ code, blockedPath: true }).result.status).toBe(code || 1);
  });
  it('runs diagnostics after normal upstream failures without weakening the browser gate or changing upload path', () => {
    const workflow = yaml.safeLoad(readFileSync('.github/workflows/main-post-merge-smoke.yml', 'utf8')) as {
      env: Record<string, string>;
      jobs: Record<string, { steps: WorkflowStep[] }>;
    };
    const steps = workflow.jobs['smoke-gate'].steps;
    const stepNamed = (name: string) => {
      const step = steps.find((candidate) => candidate.name === name);
      if (!step) throw new Error(`Missing required step: ${name}`);
      return step;
    };
    const compact = stepNamed('Run compact smoke suite');
    const diagnostics = stepNamed('Run smoke diagnostics after an earlier gate failure');
    const browser = stepNamed('Validate no-hybrid browser network');
    const upload = stepNamed('Upload smoke artifact');
    expect(compact.if).toBeUndefined();
    expect(compact.id).toBe('compact_smoke');
    expect(diagnostics.if).toBe("${{ failure() && !cancelled() && steps.compact_smoke.outcome == 'skipped' }}");
    expect(diagnostics.env?.SMOKE_UPSTREAM_STATUS).toBe('${{ job.status }}');
    expect(diagnostics.run).toBe('bash scripts/ci/orchestrate.sh smoke');
    expect(diagnostics['continue-on-error']).toBeUndefined();
    expect(compact.run).toBe('bash scripts/ci/orchestrate.sh smoke');
    expect(compact['continue-on-error']).toBeUndefined();
    expect(browser.run).toBe('npm run test:e2e:no-hybrid');
    expect(browser['continue-on-error']).toBeUndefined();
    expect(upload.if).toBe('always()');
    expect(upload.with?.['if-no-files-found']).toBe('error');
    expect(upload.with?.path).toBe('/tmp/ci/main-post-merge-smoke.json');
    expect(compact.env?.SMOKE_REPORT_PATH).toBe(upload.with?.path);
    expect(diagnostics.env?.SMOKE_REPORT_PATH).toBe(upload.with?.path);
    expect(workflow.env.NODE_VERSION).toBe('20.19.0');
  });
});
