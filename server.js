/**
 * Express Server for GCP Cloud Run
 * Serves the Vite SPA build + API routes
 * 
 * This replaces Vercel's hosting by combining:
 * - Static file serving (dist/)
 * - API serverless functions (api/)
 * - SPA fallback routing
 * - Security headers
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import {
  createLegacyFunctionRawBodyParser,
  legacyFunctionParserError,
  preserveLegacyFunctionRawBody,
} from './api/shared/legacyFunctionRawBody.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const DIST_DIR = join(__dirname, 'dist');
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const CLOUD_RUN_REVISION = /^[a-z][a-z0-9-]{0,62}$/;

// Adapt Vercel-style handlers to the Cloud Run Express runtime.
const wrapHandler = (handlerModule) => async (req, res) => {
  try {
    const handler = handlerModule.default || handlerModule;
    await handler(req, res);
  } catch (err) {
    console.error('API route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

// Keep lazy loading, but make every deployable API module explicit. Besides
// preventing path injection, this gives the no-hybrid gate a complete static
// runtime graph instead of an unbounded template import.
const API_LOADERS = Object.freeze({
  'analytics/collect': () => import('./api/analytics/collect.js'),
  'analytics/realtime': () => import('./api/analytics/realtime.js'),
  'career-application': () => import('./api/career-application.js'),
  'community/asset': () => import('./api/community/asset.js'),
  'community/post-detail': () => import('./api/community/post-detail.js'),
  'community/posts': () => import('./api/community/posts.js'),
  'contact-notification': () => import('./api/contact-notification.js'),
  'delete-account': () => import('./api/delete-account.js'),
  deployments: () => import('./api/deployments.js'),
  'enrich-preferences': () => import('./api/enrich-preferences.js'),
  'gemini-chat': () => import('./api/gemini-chat.js'),
  'gemini-ephemeral-token': () => import('./api/gemini-ephemeral-token.js'),
  'generate-investor-profile': () => import('./api/generate-investor-profile.js'),
  'generate-profile-intelligence': () => import('./api/generate-profile-intelligence.js'),
  'gcp-data': () => import('./api/gcp-data.js'),
  'gcp-storage': () => import('./api/gcp-storage.js'),
  'google-wallet-pass': () => import('./api/google-wallet-pass.js'),
  'hushh-research-client': () => import('./api/hushh-research-client.js'),
  'legacy-functions': () => import('./api/legacy-functions.js'),
  'metrics/send-report': () => import('./api/metrics/send-report.js'),
  'metrics/summary': () => import('./api/metrics/summary.js'),
  'public-investor-profile': () => import('./api/public-investor-profile.js'),
  'send-email-notification': () => import('./api/send-email-notification.js'),
  'stock-quotes': () => import('./api/stock-quotes.js'),
  'wallet-pass': () => import('./api/wallet-pass.js'),
});

const loadApi = async (name) => {
  const loader = API_LOADERS[name];
  if (!loader) throw new Error(`Unknown API route: ${name}`);
  return loader();
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Global security headers for Cloud Run. This file is the authoritative runtime config.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.plaid.com https://*.plaid.com https://www.google.com https://www.gstatic.com https://www.googletagmanager.com https://www.google-analytics.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.plaid.com",
      "font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com data:",
      "img-src 'self' data: blob: https: http:",
      // Wallet upstream traffic must stay behind same-origin /api proxies to avoid CSP regressions.
      "connect-src 'self' https://*.plaid.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.google.com https://www.gstatic.com https://www.google-analytics.com https://www.googletagmanager.com https://generativelanguage.googleapis.com https://*.googleapis.com https://www.walletlink.org wss://www.walletlink.org wss://mainnet.infura.io wss://*.infura.io https://*.seondnsresolve.com https://www.recaptcha.net https://hushhtech-nda-generation-53407187172.us-central1.run.app",
      "frame-src 'self' https://cdn.plaid.com https://*.plaid.com https://www.google.com https://www.gstatic.com https://calendly.com https://www.recaptcha.net https://lookerstudio.google.com https://datastudio.google.com https://gamma.app https://*.gamma.app https://*.gamma.site",
      "media-src 'self' blob: data:",
      "worker-src 'self' blob:",
      "child-src 'self' blob: https://cdn.plaid.com https://*.plaid.com https://gamma.app https://*.gamma.app https://*.gamma.site",
    ].join('; ')
  );
  res.setHeader(
    'Permissions-Policy',
    'camera=*, microphone=(), geolocation=(self), encrypted-media=*, accelerometer=*'
  );
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-DNS-Prefetch-Control', 'on');
  next();
});

// Preserve exact bytes for every explicit legacy-function contract before any
// general body parser runs. Signed webhook verification must use these bytes,
// and ordinary JSON contracts validate syntax without changing the payload.
app.use('/functions/v1', createLegacyFunctionRawBodyParser({ limit: '10mb' }));
app.use('/functions/v1', preserveLegacyFunctionRawBody);

// This route owns its exact 8 KiB raw-byte boundary. Keep it before every
// general parser so the default-off gate cannot consume a request body and a
// whitespace-heavy payload cannot shrink through JSON reserialization.
app.all('/api/stock-quotes', async (req, res) => wrapHandler(await loadApi('stock-quotes'))(req, res));
app.put(
  '/api/gcp/storage/*',
  express.raw({ limit: '25mb', type: '*/*' }),
  async (req, res) => wrapHandler(await loadApi('gcp-storage'))(req, res),
);
app.get('/api/gcp/storage/*', async (req, res) => wrapHandler(await loadApi('gcp-storage'))(req, res));

// Parse non-compatibility JSON and form bodies.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(legacyFunctionParserError);

// ---------------------------------------------------------------------------
// API Routes — adapt Vercel handler(req, res) → Express route
// ---------------------------------------------------------------------------

// Public, non-secret release identity. The UAT deploy workflow binds the full
// reviewed Git SHA into both the Cloud Run revision and this live response.
// A missing or malformed binding is unhealthy rather than silently reporting
// a stale short SHA from an older revision label.
app.get('/api/release', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const commitSha = process.env.DEPLOY_COMMIT_SHA ?? '';
  const revision = process.env.K_REVISION ?? '';
  const service = process.env.K_SERVICE ?? '';
  if (
    !FULL_GIT_SHA.test(commitSha) ||
    !CLOUD_RUN_REVISION.test(revision) ||
    service !== 'hushh-tech-website'
  ) {
    return res.status(503).json({
      status: 'unavailable',
      code: 'RELEASE_IDENTITY_UNAVAILABLE',
    });
  }

  return res.status(200).json({
    status: 'ok',
    service,
    revision,
    commit_sha: commitSha,
  });
});

app.all('/api/career-application', async (req, res) => wrapHandler(await loadApi('career-application'))(req, res));
app.all('/api/enrich-preferences', async (req, res) => wrapHandler(await loadApi('enrich-preferences'))(req, res));
app.all('/api/gemini-chat', async (req, res) => wrapHandler(await loadApi('gemini-chat'))(req, res));
app.all('/api/gemini-ephemeral-token', async (req, res) => wrapHandler(await loadApi('gemini-ephemeral-token'))(req, res));
app.all('/api/generate-investor-profile', async (req, res) => wrapHandler(await loadApi('generate-investor-profile'))(req, res));
app.all('/api/generate-profile-intelligence', async (req, res) => wrapHandler(await loadApi('generate-profile-intelligence'))(req, res));
app.all('/api/delete-account', async (req, res) => wrapHandler(await loadApi('delete-account'))(req, res));
app.post('/api/gcp/data', async (req, res) => wrapHandler(await loadApi('gcp-data'))(req, res));
app.post('/api/gcp/storage', async (req, res) => wrapHandler(await loadApi('gcp-storage'))(req, res));
app.delete('/api/gcp/storage', async (req, res) => wrapHandler(await loadApi('gcp-storage'))(req, res));
app.all('/api/analytics/collect', async (req, res) => wrapHandler(await loadApi('analytics/collect'))(req, res));
app.all('/api/analytics/realtime', async (req, res) => wrapHandler(await loadApi('analytics/realtime'))(req, res));
app.all('/api/community/posts', async (req, res) => wrapHandler(await loadApi('community/posts'))(req, res));
app.all('/api/community/posts/*', async (req, res) => wrapHandler(await loadApi('community/post-detail'))(req, res));
app.all('/api/community/assets/*', async (req, res) => wrapHandler(await loadApi('community/asset'))(req, res));
app.all('/api/metrics/summary', async (req, res) => wrapHandler(await loadApi('metrics/summary'))(req, res));
app.all('/api/metrics/send-report', async (req, res) => wrapHandler(await loadApi('metrics/send-report'))(req, res));
app.all('/api/deployments', async (req, res) => wrapHandler(await loadApi('deployments'))(req, res));
app.all('/api/public-investor-profile', async (req, res) => wrapHandler(await loadApi('public-investor-profile'))(req, res));
app.all('/api/send-email-notification', async (req, res) => wrapHandler(await loadApi('send-email-notification'))(req, res));
app.all('/api/contact-notification', async (req, res) => wrapHandler(await loadApi('contact-notification'))(req, res));
app.all('/api/wallet-pass', async (req, res) => wrapHandler(await loadApi('wallet-pass'))(req, res));
app.all('/api/google-wallet-pass', async (req, res) => wrapHandler(await loadApi('google-wallet-pass'))(req, res));
app.all('/api/hushh-research/config', async (req, res) => wrapHandler(await loadApi('hushh-research-client'))(req, res));
app.all('/api/hushh-research/*', async (req, res) => wrapHandler(await loadApi('hushh-research-client'))(req, res));

// Explicit legacy Edge Function compatibility surface. The generated
// retirement registry contains exactly 112 known slugs; unknown, retired, and
// not-yet-verified entries fail closed and never proxy back to Supabase.
app.all('/functions/v1/*', async (req, res) => wrapHandler(await loadApi('legacy-functions'))(req, res));

// ---------------------------------------------------------------------------
// .well-known routes (Apple App Site Association, etc.)
// ---------------------------------------------------------------------------
app.use('/.well-known', express.static(join(DIST_DIR, '.well-known'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('apple-app-site-association')) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'max-age=3600');
    }
  },
}));

// ---------------------------------------------------------------------------
// Static Assets — hashed files get immutable cache, HTML gets no-cache
// ---------------------------------------------------------------------------

// Hashed assets (JS, CSS, images in /assets/) → long cache
app.use('/assets', express.static(join(DIST_DIR, 'assets'), {
  maxAge: '1y',
  immutable: true,
}));

// Other static files (favicon, robots.txt, sitemap.xml, PDFs, images, etc.)
app.use(express.static(DIST_DIR, {
  maxAge: '1h',
  // Don't serve index.html for directory requests — we handle SPA fallback below
  index: false,
}));

// ---------------------------------------------------------------------------
// SPA Fallback — all non-API, non-asset routes serve index.html
// ---------------------------------------------------------------------------

// No-cache pages (auth, profile, onboarding, etc.)
const NO_CACHE_PATHS = [
  '/login', '/signup', '/onboarding', '/hushh-user-profile',
  '/discover-fund-a', '/profile', '/community', '/delete-account', '/sign-nda', '/metric', '/metrics', '/deployments',
];

app.get('/metric', (_req, res) => {
  res.redirect(302, '/metrics');
});

app.get('*', (req, res) => {
  // Set no-cache for dynamic pages
  const isNoCachePath = NO_CACHE_PATHS.some((p) => req.path === p || req.path.startsWith(p + '/'));
  if (isNoCachePath || req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  if (
    req.path === '/metric' ||
    req.path.startsWith('/metric/') ||
    req.path === '/metrics' ||
    req.path.startsWith('/metrics/')
  ) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  res.sendFile(join(DIST_DIR, 'index.html'));
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------
export { app };

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Hushh Tech Website running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}
