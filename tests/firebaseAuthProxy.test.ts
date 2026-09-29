import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse, type RequestOptions } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => vi.fn());
vi.mock('node:https', async (original) => ({
  ...await original<typeof import('node:https')>(), request: transport,
}));
// CI runs tests before building dist/. Supply only the SPA shell read by the
// real server; leave filesystem behavior for every other path unchanged.
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>();
  const { resolve } = await import('node:path');
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      args[0] === resolve('dist/index.html')
        ? '<!doctype html><html><head></head><body><div id="root">auth-proxy-test-shell</div></body></html>'
        : actual.readFileSync(...args),
  };
});
import { createFirebaseAuthProxy } from '../api/shared/firebaseAuthProxy.js';
import { app as realApp } from '../server.js';

const HOST = 'uat.hushhtech.com';
const PROJECT = 'hushh-tech-uat';
const enabled = { GOOGLE_CLOUD_PROJECT: PROJECT, FIREBASE_PROJECT_ID: PROJECT };
const servers: Server[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let upstreamPort: number;

async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function fixture(options = {}) {
  const app = express();
  app.use(createFirebaseAuthProxy({ env: enabled, ...options }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((_req, res) => res.set('X-Fallback', 'yes').send('SPA fallback'));
  return listen(createServer(app));
}

function call(port: number, path = '/__/auth/handler', options: RequestOptions = {}, chunks: Buffer[] = []) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }>((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, ...options,
      headers: { host: HOST, ...options.headers },
    }, (res) => {
      const body: Buffer[] = [];
      res.on('data', (chunk) => body.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(body) }));
    });
    req.on('error', reject);
    chunks.forEach((chunk) => req.write(chunk));
    req.end();
  });
}

beforeEach(async () => {
  transport.mockReset();
  handler = (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('Firebase helper'); };
  upstreamPort = await listen(createServer((req, res) => handler(req, res)));
  transport.mockImplementation((options, callback) => httpRequest({
    ...options, protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort,
  }, callback));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

describe('Firebase helper fixed-upstream transport', () => {
  it.each(['/__/auth', '/__/auth/', '/__/auth/handler', '/__/auth/iframe.js', '/__/auth/links'])('owns %s before parsers and SPA', async (path) => {
    const result = await call(await fixture(), path);
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('Firebase helper');
    expect(result.headers['x-fallback']).toBeUndefined();
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).toMatchObject({
      protocol: 'https:', hostname: 'hushh-tech-uat.firebaseapp.com', port: 443,
      servername: 'hushh-tech-uat.firebaseapp.com', rejectUnauthorized: true, path,
    });
  });

  it('preserves GET query order, duplicate parameters and encoded bytes', async () => {
    const path = '/__/auth/handler?state=a%2Bb+%25&x=1&x=2&unicode=%E2%9C%93&redirect=https%3A%2F%2Fevil.example';
    let received = '';
    handler = (req, res) => { received = req.url!; res.end('ok'); };
    await call(await fixture(), path);
    expect(received).toBe(path);
    expect(transport.mock.calls[0][0].hostname).toBe('hushh-tech-uat.firebaseapp.com');
  });

  it('handles HEAD without a body and retains representation length', async () => {
    handler = (_req, res) => { res.setHeader('Content-Length', '123'); res.end(); };
    const result = await call(await fixture(), undefined, { method: 'HEAD' });
    expect(result.status).toBe(200);
    expect(result.body.length).toBe(0);
    expect(result.headers['content-length']).toBe('123');
  });

  it.each(['application/x-www-form-urlencoded', 'application/json'])('preserves POST bytes before %s parsing', async (type) => {
    const body = Buffer.from('code=a+b%25&code=second&name=Zoë 雪\n  &state=%2F%3D  ');
    let received = Buffer.alloc(0);
    let contentLength = '';
    handler = (req, res) => {
      const data: Buffer[] = [];
      req.on('data', (chunk) => data.push(chunk));
      req.on('end', () => { received = Buffer.concat(data); contentLength = req.headers['content-length']!; res.end('ok'); });
    };
    const result = await call(await fixture(), undefined, {
      method: 'POST', headers: { 'content-type': type, origin: 'https://appleid.apple.com' },
    }, [body.subarray(0, 5), body.subarray(5)]);
    expect(result.status).toBe(200);
    expect(received).toEqual(body);
    expect(contentLength).toBe(String(body.length));
    expect(transport.mock.calls[0][0].headers.origin).toBe('https://appleid.apple.com');
  });

  it.each([
    '/__/auth/../other', '/__/auth/%2e%2e/other', '/__/auth/%252e%252e/other',
    '/__/auth%2fhandler', '/__/auth/%2Fother', '/__/auth/\\other',
    '/__/%61uth/handler', '/__/auth/%', '/__/auth/a//handler', '/__/auth/handler#fragment',
  ])('rejects malformed/escaping path %s without fallback', async (path) => {
    const result = await call(await fixture(), path);
    expect(result.status).toBe(400);
    expect(result.headers['x-fallback']).toBeUndefined();
    expect(result.headers['cache-control']).toBe('no-store');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'OPTIONS'])('rejects %s with Allow', async (method) => {
    const result = await call(await fixture(), undefined, { method });
    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe('GET, HEAD, POST');
    expect(transport).not.toHaveBeenCalled();
  });

  it('accepts exactly 64 KiB', async () => {
    const result = await call(await fixture(), undefined, { method: 'POST' }, [Buffer.alloc(65536)]);
    expect(result.status).toBe(200);
    expect(transport.mock.calls[0][0].headers['content-length']).toBe('65536');
  });

  it.each([true, false])('rejects oversized POST (declared length: %s) before contacting upstream', async (declared) => {
    const body = Buffer.alloc(65537);
    const result = await call(await fixture(), undefined, {
      method: 'POST', headers: declared ? { 'content-length': String(body.length) } : {},
    }, [body]);
    expect(result.status).toBe(413);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects encoded request bodies and GET bodies', async () => {
    const port = await fixture();
    expect((await call(port, undefined, { method: 'POST', headers: { 'content-encoding': 'gzip' } })).status).toBe(415);
    expect((await call(port, undefined, { headers: { 'content-length': '1' } }, [Buffer.from('x')])).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });

  it('filters credentials, cookies, Referer, forwarding, caching and hop headers', async () => {
    await call(await fixture(), undefined, { headers: {
      authorization: 'Bearer secret', cookie: 'app_session=secret', referer: 'https://example.test/?secret',
      'x-forwarded-host': 'evil.test', 'x-forwarded-for': '1.2.3.4', 'proxy-authorization': 'secret',
      'if-none-match': 'old', 'if-modified-since': 'yesterday', range: 'bytes=0-10',
      'accept-encoding': 'gzip', accept: 'text/html', 'accept-language': 'en',
      connection: 'keep-alive, accept-language',
    } });
    expect(transport.mock.calls[0][0].headers).toEqual({ 'accept-encoding': 'identity', accept: 'text/html' });
  });

  it('preserves status, MIME, language and upstream CSP without SPA policy or cache headers', async () => {
    handler = (_req, res) => {
      res.writeHead(418, {
        'content-type': 'text/plain', 'content-language': 'en',
        'content-security-policy': "default-src 'none'", 'x-frame-options': 'SAMEORIGIN',
        'cache-control': 'public, max-age=1800', expires: 'tomorrow', etag: 'old',
        'last-modified': 'yesterday', 'surrogate-control': 'max-age=100',
        'cdn-cache-control': 'public', 'alt-svc': 'h3=":443"',
        connection: 'keep-alive, content-language',
      });
      res.end('teapot');
    };
    const result = await call(await fixture());
    expect(result.status).toBe(418);
    expect(result.headers['content-type']).toBe('text/plain');
    expect(result.headers['content-security-policy']).toBe("default-src 'none'");
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-robots-tag']).toBe('noindex');
    for (const name of ['expires', 'etag', 'last-modified', 'surrogate-control', 'cdn-cache-control', 'alt-svc', 'content-language', 'x-fallback']) {
      expect(result.headers[name], name).toBeUndefined();
    }
  });

  it('preserves separate cookies/flags while restricting domain and path; never forwards app cookies', async () => {
    handler = (_req, res) => {
      res.setHeader('Set-Cookie', [
        'helper_a=one; Domain=hushh-tech-uat.firebaseapp.com; Path=/; Secure; HttpOnly; SameSite=None',
        'helper_b=two; Path=/__/auth/handler; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure',
        'helper_c=three; Secure',
        'bad=one; Domain=.hushhtech.com; Path=/',
        'bad=two; Path=/api',
        '__Host-helper=three; Secure; Path=/',
      ]);
      res.end('ok');
    };
    const result = await call(await fixture(), undefined, { headers: { cookie: 'app=secret; helper_a=one' } });
    expect(result.headers['set-cookie']).toEqual([
      'helper_a=one; Path=/__/auth/; Secure; HttpOnly; SameSite=None',
      'helper_b=two; Path=/__/auth/handler; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure',
      'helper_c=three; Secure; Path=/__/auth/',
    ]);
    expect(transport.mock.calls[0][0].headers.cookie).toBeUndefined();
  });

  it.each([
    ['https://hushh-tech-uat.firebaseapp.com/__/auth/handler?x=%2B&x=2', 'https://uat.hushhtech.com/__/auth/handler?x=%2B&x=2'],
    ['//hushh-tech-uat.firebaseapp.com/__/auth/iframe', 'https://uat.hushhtech.com/__/auth/iframe'],
    ['https://accounts.google.com/o/oauth2/auth?state=opaque', 'https://accounts.google.com/o/oauth2/auth?state=opaque'],
    ['https://appleid.apple.com/auth/authorize', 'https://appleid.apple.com/auth/authorize'],
    ['https://hushh-tech-uat.firebaseapp.com.evil.test/__/auth/handler', 'https://hushh-tech-uat.firebaseapp.com.evil.test/__/auth/handler'],
    ['https://hushh-tech-uat.firebaseapp.com/elsewhere', 'https://hushh-tech-uat.firebaseapp.com/elsewhere'],
    ['https://hushh-tech-uat.firebaseapp.com/__/auth/../elsewhere', 'https://hushh-tech-uat.firebaseapp.com/__/auth/../elsewhere'],
    ['/__/auth/handler', '/__/auth/handler'],
  ])('handles Location %s without following it', async (location, expected) => {
    handler = (_req, res) => { res.writeHead(302, { location }); res.end(); };
    const result = await call(await fixture());
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(expected);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([false, true])('streams exact representation bytes (compressed: %s)', async (compressed) => {
    const plain = Buffer.from('helper script '.repeat(1000));
    const body = compressed ? gzipSync(plain) : plain;
    handler = (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Content-Length', String(body.length));
      if (compressed) res.setHeader('Content-Encoding', 'gzip');
      res.end(body);
    };
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', PROJECT);
    vi.stubEnv('FIREBASE_PROJECT_ID', PROJECT);
    const result = await call(await listen(createServer(realApp)), undefined, { headers: { 'accept-encoding': 'gzip' } });
    expect(result.body).toEqual(body);
    expect(result.headers['content-length']).toBe(String(body.length));
    expect(result.headers['content-encoding']).toBe(compressed ? 'gzip' : undefined);
    expect(result.headers['content-security-policy']).toBeUndefined();
  });

  it('returns 502 without retries, sensitive logs or SPA fallback', async () => {
    const logs = ['log', 'error', 'warn', 'info'].map((name) => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
    transport.mockImplementation(() => { throw new Error('OAUTH_SECRET query body cookie'); });
    const result = await call(await fixture(), '/__/auth/handler?state=OAUTH_SECRET', {
      method: 'POST', headers: { cookie: 'OAUTH_SECRET' },
    }, [Buffer.from('OAUTH_SECRET')]);
    expect(result.status).toBe(502);
    expect(result.body.toString()).not.toContain('OAUTH_SECRET');
    expect(result.headers['x-fallback']).toBeUndefined();
    expect(transport).toHaveBeenCalledOnce();
    logs.forEach((log) => expect(log).not.toHaveBeenCalled());
  });

  it('returns 502 on socket failure', async () => {
    handler = (req) => req.socket.destroy();
    const result = await call(await fixture());
    expect(result.status).toBe(502);
    expect(result.headers['cache-control']).toBe('no-store');
  });

  it('rejects an upstream hop-by-hop encoding declaration instead of corrupting bytes', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { connection: 'content-encoding', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from('helper')));
    };
    const result = await call(await fixture());
    expect(result.status).toBe(502);
    expect(result.headers['content-encoding']).toBeUndefined();
  });

  it('times out an incomplete Apple POST without sending partial credentials upstream', async () => {
    const port = await fixture({ timeoutMs: 1000, idleTimeoutMs: 40 });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/__/auth/handler',
        method: 'POST', headers: { host: HOST, 'content-length': '100' },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.write('partial');
    });
    expect(status).toBe(504);
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not contact upstream when a client aborts during POST upload', async () => {
    const port = await fixture();
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/__/auth/handler',
      method: 'POST', headers: { host: HOST, 'content-length': '100' },
    });
    req.on('error', () => {});
    req.write('partial');
    await new Promise((resolve) => setTimeout(resolve, 20));
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([{ timeoutMs: 40, idleTimeoutMs: 1000 }, { timeoutMs: 1000, idleTimeoutMs: 40 }])('bounds stalled upstream by %j', async (limits) => {
    handler = () => {};
    const result = await call(await fixture(limits));
    expect(result.status).toBe(504);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('cancels upstream on client disconnect', async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => { disconnected = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    handler = (req) => { req.on('close', disconnected); entered(); };
    const req = httpRequest({ hostname: '127.0.0.1', port: await fixture(), path: '/__/auth/handler', headers: { host: HOST } });
    req.on('error', () => {});
    req.end();
    await started;
    req.destroy();
    await closed;
    expect(transport).toHaveBeenCalledOnce();
  });

  it('terminates a truncated upstream response instead of appending fallback', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
      setTimeout(() => res.destroy(), 10);
    };
    await expect(call(await fixture())).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe('runtime isolation', () => {
  it.each([
    {}, { GOOGLE_CLOUD_PROJECT: PROJECT }, { FIREBASE_PROJECT_ID: PROJECT },
    { GOOGLE_CLOUD_PROJECT: 'hushh-tech-prod', FIREBASE_PROJECT_ID: PROJECT },
    { GOOGLE_CLOUD_PROJECT: PROJECT, FIREBASE_PROJECT_ID: 'hushh-pda' },
  ])('does not activate for %j', async (env) => {
    const result = await call(await fixture({ env }));
    expect(result.body.toString()).toBe('SPA fallback');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['evil.test', 'hushhtech.com', 'hushh-tech-website.run.app', `${HOST}:443`])('rejects noncanonical Host %s even with forwarded host', async (host) => {
    const result = await call(await fixture(), undefined, { headers: { host, 'x-forwarded-host': HOST } });
    expect(result.status).toBe(404);
    expect(result.headers['x-fallback']).toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['/auth/callback', '/api/release', '/api/hushh-research/config', '/login', '/__/authentication', '/assets/example.js'])('does not claim %s', async (path) => {
    expect((await call(await fixture(), path)).body.toString()).toBe('SPA fallback');
    expect(transport).not.toHaveBeenCalled();
  });

  it('adds only the required UAT sources while retaining real app route behavior', async () => {
    const port = await listen(createServer(realApp));
    for (const path of ['/auth/callback', '/login', '/api/release']) {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'hushh-tech-prod');
      const before = await call(port, path);
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', PROJECT);
      vi.stubEnv('FIREBASE_PROJECT_ID', PROJECT);
      const after = await call(port, path);
      expect(after.status).toBe(before.status);
      expect(after.body).toEqual(before.body);
      if (path !== '/api/release') {
        expect(after.status).toBe(200);
        expect(after.body.toString()).toContain('auth-proxy-test-shell');
      }
      for (const header of ['cache-control', 'x-frame-options', 'content-type', 'referrer-policy', 'permissions-policy', 'strict-transport-security']) {
        expect(after.headers[header], header).toBe(before.headers[header]);
      }
      expect(before.headers['content-security-policy']).not.toContain('https://apis.google.com');
      expect(after.headers['content-security-policy']).toBe(
        String(before.headers['content-security-policy']).replace(
          "script-src 'self'", "script-src 'self' https://apis.google.com",
        ).replace("connect-src 'self'", "connect-src 'self' https://ipwho.is https://ipwhois.app"),
      );
      expect(after.headers['content-security-policy']).toContain("frame-src 'self'");
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { cloud: PROJECT, host: HOST, allowed: true },
    { cloud: undefined, host: HOST, allowed: false },
    { cloud: 'hushh-tech-prod', host: HOST, allowed: false },
    { cloud: PROJECT, host: 'hushhtech.com', allowed: false },
    { cloud: PROJECT, host: 'other.example', allowed: false },
  ])('bounds existing IP fallback sources to UAT: %j', async ({ cloud, host, allowed }) => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', cloud);
    const result = await call(await listen(createServer(realApp)), '/onboarding/financial-link', {
      headers: { host, 'x-forwarded-host': HOST },
    });
    const directives = String(result.headers['content-security-policy']).split('; ');
    const connect = directives.find((directive) => directive.startsWith('connect-src '))!.split(' ');
    for (const origin of ['https://ipwho.is', 'https://ipwhois.app']) {
      expect(connect.includes(origin)).toBe(allowed);
      expect(directives.filter((directive) => !directive.startsWith('connect-src ')).join(';')).not.toContain(origin);
    }
    expect(connect).toContain('https://*.plaid.com');
    expect(connect).toContain('https://www.google.com');
    expect(connect).not.toContain('*');
    expect(connect).not.toContain('https:');
  });

  it('permits the existing production Firebase redirect dependencies only on canonical production', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'hushh-tech-prod');
    vi.stubEnv('FIREBASE_PROJECT_ID', 'hushh-tech-prod');
    const port = await listen(createServer(realApp));
    const baseline = await call(port, '/auth/callback', { headers: { host: 'other.example' } });
    const production = await call(port, '/auth/callback', { headers: { host: 'hushhtech.com' } });
    expect(production.status).toBe(200);
    expect(production.body).toEqual(baseline.body);
    expect(production.headers['content-security-policy']).toBe(
      String(baseline.headers['content-security-policy'])
        .replace("script-src 'self'", "script-src 'self' https://apis.google.com")
        .replace("frame-src 'self'", "frame-src 'self' https://hushh-tech-prod.firebaseapp.com"),
    );
    for (const name of ['x-frame-options', 'referrer-policy', 'permissions-policy', 'strict-transport-security']) {
      expect(production.headers[name]).toBe(baseline.headers[name]);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { cloud: 'hushh-tech-prod', firebase: PROJECT, host: 'hushhtech.com' },
    { cloud: PROJECT, firebase: 'hushh-tech-prod', host: 'hushhtech.com' },
    { cloud: 'hushh-tech-prod', firebase: undefined, host: 'hushhtech.com' },
    { cloud: 'hushh-tech-prod', firebase: 'hushh-tech-prod', host: 'hushhtech.com.evil.test' },
    { cloud: 'hushh-tech-prod', firebase: 'hushh-tech-prod', host: 'other.example' },
    { cloud: 'hushh-tech-prod', firebase: 'hushh-tech-prod', host: HOST },
  ])('does not grant production Firebase sources to mismatched authority: %j', async ({ cloud, firebase, host }) => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', cloud);
    vi.stubEnv('FIREBASE_PROJECT_ID', firebase);
    const result = await call(await listen(createServer(realApp)), '/auth/callback', {
      headers: { host, 'x-forwarded-host': 'hushhtech.com' },
    });
    expect(result.headers['content-security-policy']).not.toContain('https://apis.google.com');
    expect(result.headers['content-security-policy']).not.toContain('https://hushh-tech-prod.firebaseapp.com');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { cloud: undefined, firebase: PROJECT, host: HOST },
    { cloud: PROJECT, firebase: undefined, host: HOST },
    { cloud: 'hushh-tech-prod', firebase: 'hushh-tech-prod', host: HOST },
    { cloud: PROJECT, firebase: 'hushh-pda', host: HOST },
    { cloud: PROJECT, firebase: PROJECT, host: 'hushhtech.com' },
    { cloud: PROJECT, firebase: PROJECT, host: 'other.example' },
  ])('does not add the gapi CSP exception outside canonical UAT: %j', async ({ cloud, firebase, host }) => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', cloud);
    vi.stubEnv('FIREBASE_PROJECT_ID', firebase);
    const result = await call(await listen(createServer(realApp)), '/auth/callback', {
      headers: { host, 'x-forwarded-host': HOST },
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-security-policy']).not.toContain('https://apis.google.com');
    expect(result.headers['content-security-policy']).toContain("frame-src 'self'");
    expect(transport).not.toHaveBeenCalled();
  });
});


describe('production same-origin redirect transport', () => {
  const env = { GOOGLE_CLOUD_PROJECT: 'hushh-tech-prod', FIREBASE_PROJECT_ID: 'hushh-tech-prod' };
  it.each(['GET', 'POST'])('preserves %s provider callbacks with production-only TLS upstream', async (method) => {
    const body = Buffer.from('code=synthetic%2Bcode&state=synthetic+state');
    let received = Buffer.alloc(0);
    handler = (req, res) => {
      req.on('data', chunk => { received = Buffer.concat([received, chunk]); });
      req.on('end', () => res.end('production helper'));
    };
    const result = await call(await fixture({ env }), '/__/auth/handler?x=%2B', {
      method, headers: { host: 'hushhtech.com', cookie: 'private=do-not-forward', authorization: 'Bearer synthetic',
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    }, method === 'POST' ? [body] : []);
    expect(result.status).toBe(200);
    expect(received).toEqual(method === 'POST' ? body : Buffer.alloc(0));
    expect(transport.mock.calls[0][0]).toMatchObject({ hostname: 'hushh-tech-prod.firebaseapp.com',
      servername: 'hushh-tech-prod.firebaseapp.com', rejectUnauthorized: true, path: '/__/auth/handler?x=%2B' });
    expect(transport.mock.calls[0][0].headers).not.toHaveProperty('cookie');
    expect(transport.mock.calls[0][0].headers).not.toHaveProperty('authorization');
  });
  it.each(['uat.hushhtech.com', 'hushhtech.com:443', 'evil.example'])('rejects cross-environment Host %s', async (host) => {
    expect((await call(await fixture({ env }), undefined, { headers: { host } })).status).toBe(404);
    expect(transport).not.toHaveBeenCalled();
  });
  it('rewrites only the production helper redirect and scopes its cookies', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: 'https://hushh-tech-prod.firebaseapp.com/__/auth/handler?state=%2B',
        'set-cookie': ['helper=synthetic; Domain=hushh-tech-prod.firebaseapp.com; Path=/; Secure; HttpOnly',
          'wrong=synthetic; Domain=hushh-tech-uat.firebaseapp.com; Path=/; Secure'] });
      res.end();
    };
    const result = await call(await fixture({ env }), undefined, { headers: { host: 'hushhtech.com' } });
    expect(result.headers.location).toBe('https://hushhtech.com/__/auth/handler?state=%2B');
    expect(result.headers['set-cookie']).toEqual(['helper=synthetic; Path=/__/auth/; Secure; HttpOnly']);
  });
});
