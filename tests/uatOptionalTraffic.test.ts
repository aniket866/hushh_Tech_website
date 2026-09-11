// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isUatWebsite } from '../src/services/uatOptionalTraffic';
import { useStockQuotes } from '../src/hooks/useStockQuotes';
import { trackSiteEvent } from '../src/services/analytics/siteAnalytics';
import HushhTechTicker from '../src/components/hushh-tech-ticker/HushhTechTicker';

const session = vi.hoisted(() => vi.fn(async () => ({ data: { session: null } })));
vi.mock('../src/resources/config/config', () => ({ default: { gcpBackendClient: { auth: { getSession: session } } } }));
vi.mock('../src/services/hushhResearch/firebaseAuth', () => ({ isHushhResearchAuthMode: () => false }));
vi.mock('../src/auth/AuthSessionProvider', () => ({ useOptionalAuthSession: () => null }));

const routes = ['/', '/discover-fund-a', '/community', '/contact', '/about/leadership', '/faq', '/career', '/profile', '/sign-nda'];
let root: Root;
let container: HTMLDivElement;
const at = (url: string) => {
  const location = new URL(url);
  vi.stubGlobal('window', new Proxy(window, {
    get(target, key) { return key === 'location' ? location : Reflect.get(target, key); },
  }));
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, quotes: [] }) }));
  session.mockClear();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('UAT optional requests', () => {
  it.each(['hushhtech.com', 'localhost', 'uat.hushh.ai', 'uat.hushhtech.com.example.com'])('does not change other hosts: %s', (host) => {
    expect(isUatWebsite(host)).toBe(false);
  });
  it.each(routes)('does not send optional analytics or resolve a token on %s', async (route) => {
    at(`https://uat.hushhtech.com${route}`);
    await trackSiteEvent('page_view');
    await trackSiteEvent('route_engagement', { routePath: '/profile' });
    expect(fetch).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });
  it('prevents initial, manual and interval stock requests on UAT', async () => {
    at('https://uat.hushhtech.com/');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let result: ReturnType<typeof useStockQuotes>;
    function Probe() { result = useStockQuotes(120000); return null; }
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => { await result!.refetch(); vi.advanceTimersByTime(360000); });
    expect(fetch).not.toHaveBeenCalled();
    expect(result!.loading).toBe(false);
    expect(result!.lastUpdated).toBeNull();
  });
  it.each(routes)('does not render a misleading live ticker or request logos on %s', async (route) => {
    at(`https://uat.hushhtech.com${route}`);
    await act(async () => root.render(React.createElement(HushhTechTicker)));
    expect(container.querySelector('[data-hushh-ticker]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves production stock and collector requests', async () => {
    at('https://hushhtech.com/');
    function Probe() { useStockQuotes(0); return null; }
    await act(async () => root.render(React.createElement(Probe)));
    await trackSiteEvent('page_view');
    expect(fetch).toHaveBeenCalledWith('/api/stock-quotes', expect.objectContaining({ method: 'POST' }));
    expect(fetch).toHaveBeenCalledWith('/api/analytics/collect', expect.objectContaining({ method: 'POST' }));
  });
});
