// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUatNdaPage } from '../src/services/nda/uatNdaPage';

vi.mock('../src/resources/config/config', () => ({
  default: { gcpBackendClient: { auth: { getSession: async () => ({ data: { session: null } }) } } },
}));
vi.mock('../src/services/hushhResearch/firebaseAuth', () => ({ isHushhResearchAuthMode: () => false }));

afterEach(() => vi.unstubAllGlobals());

describe('optional UAT NDA traffic boundary', () => {
  it.each(['/sign-nda', '/sign-nda/', '/SIGN-NDA'])('matches the actual route %s', (path) => {
    expect(isUatNdaPage(path, 'uat.hushhtech.com')).toBe(true);
  });
  it.each([
    ['/sign-nda', 'hushhtech.com'],
    ['/sign-nda', 'localhost'],
    ['/sign-nda-extra', 'uat.hushhtech.com'],
    ['/profile', 'uat.hushhtech.com'],
    ['/sign-nda/other', 'uat.hushhtech.com'],
  ])('leaves unrelated route/host %s %s unchanged', (path, host) => {
    expect(isUatNdaPage(path, host)).toBe(false);
  });
  it.each([
    ['/sign-nda', undefined],
    ['/sign-nda', '/profile'],
    ['/profile', '/sign-nda'],
  ])('never sends collection requests for NDA current/exit events', async (path, routePath) => {
    vi.stubGlobal('window', { location: new URL(`https://uat.hushhtech.com${path}`) });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { trackSiteEvent } = await import('../src/services/analytics/siteAnalytics');
    await trackSiteEvent('page_view', { routePath });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    'https://hushhtech.com/sign-nda',
    'https://hushhtech.com/profile',
  ])('still sends optional analytics outside the boundary: %s', async (url) => {
    const { localStorage, sessionStorage } = window;
    vi.stubGlobal('window', { location: new URL(url), localStorage, sessionStorage });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { trackSiteEvent } = await import('../src/services/analytics/siteAnalytics');
    await trackSiteEvent('page_view');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/analytics/collect');
  });
  it('uses the existing header switch and skips only optional PDF generation', () => {
    const page = readFileSync('src/pages/sign-nda/index.tsx', 'utf8');
    expect(page).toContain('<HushhTechHeader showTicker={!isUatNdaPage()} />');
    expect(page).toContain('if (!isUatNdaPage())');
    expect(page).toContain('const result = await signNDA(');
    const service = readFileSync('src/services/nda/ndaService.ts', 'utf8');
    expect(service).not.toContain('isUatNdaPage');
  });
});
