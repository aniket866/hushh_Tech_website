import { request as httpsRequest } from 'node:https';

const TARGETS = Object.freeze({
  'hushh-tech-uat': Object.freeze({ host: 'uat.hushhtech.com', upstream: 'hushh-tech-uat.firebaseapp.com' }),
  'hushh-tech-prod': Object.freeze({ host: 'hushhtech.com', upstream: 'hushh-tech-prod.firebaseapp.com' }),
});
const PREFIX = '/__/auth';
const MAX_BODY_BYTES = 64 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST']);
const HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
];
const REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'origin'];
const RESPONSE_HEADERS = [
  'content-type', 'content-encoding', 'content-length', 'content-language',
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'location', 'set-cookie',
];

function connectionHeaders(headers) {
  return new Set([
    ...HOP_HEADERS,
    ...String(headers.connection || '').toLowerCase().split(',').map((part) => part.trim()),
  ]);
}

function ownsPath(path) {
  // Recognize encoded namespace/separator attempts so they fail here rather
  // than reaching Express's decoding, static serving or SPA fallback.
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* validated below */ }
  return /^\/__\/auth(?:$|[/\\%])/.test(path) ||
    /^\/__\/auth(?:$|[/\\%])/.test(decoded);
}

function validPath(path) {
  // Helpers use ordinary ASCII path segments. Do not normalize a URL and then
  // forward it: normalization would conceal traversal. Query bytes are separate.
  return /^\/__\/auth(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*\/?$/.test(path);
}

function rewriteLocation(value, target) {
  if (typeof value !== 'string') return value;
  // Preserve the suffix byte-for-byte. Never rewrite provider destinations or
  // merely similar hostnames, ports, protocols, paths, or query-string values.
  const match = /^(?:https:)?\/\/([^/]+)(\/__\/auth(?:[/?#]|$).*)$/.exec(value);
  return match && match[1] === target.upstream && validPath(match[2].split(/[?#]/)[0])
    ? `https://${target.host}${match[2]}` : value;
}

function scopeCookie(value, target) {
  const parts = value.split(';');
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=/.test(parts[0])) return null;
  const attributes = [];
  for (const part of parts.slice(1)) {
    const attribute = part.trim();
    if (/^domain\s*=/i.test(attribute)) {
      const domain = attribute.slice(attribute.indexOf('=') + 1).trim().replace(/^\./, '').toLowerCase();
      // Remove this exact Domain attribute to make the cookie host-only on the matching application origin.
      // Unexpected domains must never set cookies on the application origin.
      if (domain !== target.upstream) return null;
    } else if (/^path\s*=/i.test(attribute)) {
      const path = attribute.slice(attribute.indexOf('=') + 1).trim();
      if (path === '/' || path === PREFIX || path === `${PREFIX}/`) {
        attributes.push(`Path=${PREFIX}/`);
      } else if (path.startsWith(`${PREFIX}/`) && validPath(path)) {
        attributes.push(`Path=${path}`);
      } else return null;
    } else if (attribute) attributes.push(attribute);
  }
  // A __Host- cookie requires Path=/; don't silently violate its semantics or
  // grant a helper cookie application-wide scope. Live use requires review.
  if (parts[0].startsWith('__Host-')) return null;
  if (!attributes.some((part) => /^path=/i.test(part))) attributes.push(`Path=${PREFIX}/`);
  return [parts[0], ...attributes].join('; ');
}

/**
 * Fixed-upstream, environment-isolated helper transport. Injectable I/O/deadlines are for tests;
 * neither the browser nor environment variables can select the upstream.
 *
 * Cookie contract: retain host-only/path-scoped upstream Set-Cookie responses,
 * but forward NO browser Cookie header. Current unauthenticated managed helpers
 * set no cookies and Firebase's redirect relay uses browser storage. If live
 * Google/Apple completion proves inbound cookies necessary, a reviewed exact
 * cookie-name allowlist is required before changing authDomain. Do not forward
 * all application cookies, rename cookie names, or weaken Secure/SameSite flags.
 *
 * CSP contract: preserve Firebase's managed CSP, if supplied. Do not apply the
 * SPA CSP to helper documents or modify the application's global CSP. Provider
 * completion/CSP and platform request-log privacy still require UAT verification.
 */
export function createFirebaseAuthProxy({
  request = httpsRequest,
  env = process.env,
  timeoutMs = 30_000,
  idleTimeoutMs = 15_000,
} = {}) {
  return function firebaseAuthProxy(req, res, next) {
    const project = env.GOOGLE_CLOUD_PROJECT;
    const destination = Object.hasOwn(TARGETS, project) ? TARGETS[project] : undefined;
    if (!destination || env.FIREBASE_PROJECT_ID !== project) return next();
    const target = req.url;
    const path = target.split('?')[0];
    if (!ownsPath(path)) return next();

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

    let upstreamRequest;
    let upstreamResponse;
    let finished = false;
    let timer;
    let idleTimer;
    const chunks = [];
    let bytes = 0;

    const stop = () => {
      finished = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      chunks.length = 0;
      upstreamRequest?.destroy();
      upstreamResponse?.destroy();
    };
    const fail = (status) => {
      if (finished) return;
      stop();
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      // Drop representation/redirect/cookie headers staged before an error.
      for (const header of RESPONSE_HEADERS) res.removeHeader(header);
      res.statusCode = status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      if (!req.complete) res.setHeader('Connection', 'close');
      res.end(req.method === 'HEAD' ? undefined : `Auth helper request failed (${status}).`);
    };
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(504), idleTimeoutMs);
    };

    function send(body) {
      if (finished) return;
      const blocked = connectionHeaders(req.headers);
      const headers = { 'accept-encoding': 'identity' };
      for (const name of REQUEST_HEADERS) {
        if (!blocked.has(name) && typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      }
      if (req.method === 'POST') headers['content-length'] = String(body.length);
      try {
        upstreamRequest = request({
          protocol: 'https:', hostname: destination.upstream, port: 443,
          servername: destination.upstream, rejectUnauthorized: true,
          method: req.method, path: target, headers,
        }, (incoming) => {
          upstreamResponse = incoming;
          if (finished) { incoming.destroy(); return; }
          touch();
          const status = incoming.statusCode;
          if (!Number.isInteger(status) || status < 200 || status > 599) { fail(502); return; }
          const excluded = connectionHeaders(incoming.headers);
          // Removing an encoding header while forwarding its encoded bytes
          // would corrupt the representation. Fail rather than mislabel it.
          if (incoming.headers['content-encoding'] && excluded.has('content-encoding')) { fail(502); return; }
          try {
            for (const name of RESPONSE_HEADERS) {
              let value = incoming.headers[name];
              if (value === undefined || excluded.has(name)) continue;
              if (name === 'content-length' && !/^\d+$/.test(String(value))) { fail(502); return; }
              if (name === 'location') value = rewriteLocation(value, destination);
              if (name === 'set-cookie') {
                value = (Array.isArray(value) ? value : [value]).map((cookie) => scopeCookie(cookie, destination)).filter(Boolean);
                if (!value.length) continue;
              }
              res.setHeader(name, value);
            }
            res.statusCode = status;
            if (status === 204 || status === 304) {
              res.removeHeader('Content-Length');
              res.removeHeader('Content-Encoding');
            }
            incoming.on('data', touch);
            incoming.on('error', () => fail(502));
            incoming.on('aborted', () => fail(502));
            incoming.on('end', () => {
              if (!incoming.complete) fail(502);
            });
            // node:https does not decompress; pipe preserves bytes and applies
            // backpressure. This route never enters Express compression/send().
            incoming.pipe(res);
          } catch { fail(502); }
        });
        upstreamRequest.on('error', () => fail(502));
        upstreamRequest.on('upgrade', (_response, socket) => { socket.destroy(); fail(502); });
        upstreamRequest.end(body);
      } catch { fail(502); }
    }

    function onData(chunk) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { fail(413); req.resume(); return; }
      chunks.push(chunk);
      touch();
    }
    function onEnd() {
      const body = Buffer.concat(chunks, bytes);
      chunks.length = 0;
      send(body);
    }

    req.on('aborted', stop);
    req.on('error', () => fail(400));
    res.on('close', stop);
    res.on('finish', stop);
    res.on('error', stop);
    if (req.headers.host !== destination.host) { fail(404); req.resume(); return; }
    if (!validPath(path) || [...target].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '#')) {
      fail(400); req.resume(); return;
    }
    if (!METHODS.has(req.method)) {
      res.setHeader('Allow', 'GET, HEAD, POST');
      fail(405); req.resume(); return;
    }
    // Compressed request bodies would need decompression to enforce a meaningful
    // limit; Firebase form callbacks are uncompressed. Reject instead of altering.
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      fail(415); req.resume(); return;
    }
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      fail(413); req.resume(); return;
    }
    if (req.method !== 'POST' && (Number(length || 0) > 0 || req.headers['transfer-encoding'])) {
      fail(400); req.resume(); return;
    }
    timer = setTimeout(() => fail(504), timeoutMs);
    touch();
    if (req.method === 'POST') {
      req.on('data', onData);
      req.on('end', onEnd);
    } else send(undefined);
  };
}
