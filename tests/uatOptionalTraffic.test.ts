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
  // SUPERSEDED, deliberately. f779d42e suppressed stock requests on UAT because the gateway there
  // answered 404 FEATURE_DISABLED and the rows rendered were `generateFallbackData()`'s invented
  // numbers. Both premises are gone: the gateway is enabled on the UAT service and returns live
  // prices, and nothing fabricates a quote any more. The protection that mattered -- never show a
  // number we do not have -- is now carried by `hasQuote` on every host, and is asserted below and
  // in tests/stockQuoteIntegrity.test.ts. Suppression here would only hide a working ticker.
  it('requests stock quotes on UAT, where the gateway is enabled', async () => {
    at('https://uat.hushhtech.com/');
    function Probe() { useStockQuotes(0); return null; }
    await act(async () => root.render(React.createElement(Probe)));
    expect(fetch).toHaveBeenCalledWith('/api/stock-quotes', expect.objectContaining({ method: 'POST' }));
  });
  // Same protection, stronger rule. The gateway answers with no quotes here, so no row carries a
  // real price and the strip renders nothing — by `hasQuote`, not by hostname, so it holds in
  // production too. The analytics collector stays off on UAT, which is the part still keyed to the
  // host, so this asserts that the one request made is the quote fetch and nothing else.
  it.each(routes)('does not render a misleading live ticker or request logos on %s', async (route) => {
    at(`https://uat.hushhtech.com${route}`);
    await act(async () => root.render(React.createElement(HushhTechTicker)));
    expect(container.querySelector('[data-hushh-ticker]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[0]);
    expect(urls).toEqual(['/api/stock-quotes']);
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
