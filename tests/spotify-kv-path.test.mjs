// Isolated, offline proof of the spotify-proxy KV token path — no production
// OAuth, no network: fetch is stubbed, the Cache API is mocked, the KV binding
// is an in-memory fake and the refresh token is a synthetic value.
//
// What this proves (per docs/cloudflare-write-plan.md, W2 correction):
//  - cold cache  → the KV path (env.TOKENS.get) IS exercised, token cached;
//  - warm cache  → NO KV reads happen (caches.default.match answers first).
// A normal /now-playing request against a warm cache is therefore functional
// smoke only, never evidence of KV access.
import test from 'node:test';
import assert from 'node:assert/strict';

// Mock the Cache API BEFORE importing the worker module.
const store = new Map();
const worker = await (async () => {
  globalThis.caches = {
    default: {
      match: async (key) => store.get(String(key)),
      put: async (key, resp) => { store.set(String(key), resp); },
    },
  };
  return (await import('../workers/spotify-proxy.js')).default;
})();

const TOKEN_CACHE_KEY = 'https://spotify-token-cache.local/access_token/v2';

function makeEnv(kvLog) {
  return {
    SPOTIFY_CLIENT_ID: 'synthetic-client-id',
    SPOTIFY_CLIENT_SECRET: 'synthetic-client-secret',
    TOKENS: {
      get: async (k) => { kvLog.push(k); return 'synthetic-refresh-token'; },
    },
  };
}
const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}) };
const request = () => new Request('https://worker.example/now-playing', {
  headers: { 'CF-Connecting-IP': '192.0.2.1' },
});

test('cold cache: /now-playing exercises the KV path and writes the token cache', async (t) => {
  const realFetch = globalThis.fetch;
  const hit = [];
  globalThis.fetch = async (url) => {
    hit.push(String(url));
    if (String(url) === 'https://accounts.spotify.com/api/token') {
      return new Response(JSON.stringify({ access_token: 'synthetic-access-token' }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };
  const kvLog = [];
  try {
    const resp = await worker._fetch(request(), makeEnv(kvLog), ctx);
    assert.equal(resp.status, 200);
    assert.deepEqual(kvLog, ['spotify:refresh_token'], 'cold cache must read the refresh token from KV');
    assert.ok(hit.includes('https://accounts.spotify.com/api/token'));
    const cached = store.get(TOKEN_CACHE_KEY);
    assert.ok(cached, 'token cache must be written after a KV-path token exchange');
    const data = await cached.json();
    assert.equal(data.token, 'synthetic-access-token');
  } finally {
    globalThis.fetch = realFetch;
    store.delete(TOKEN_CACHE_KEY);
  }
});

test('warm cache: /now-playing performs NO KV reads (cache answers first)', async (t) => {
  const realFetch = globalThis.fetch;
  const tokenCalls = [];
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://accounts.spotify.com/api/token') tokenCalls.push(String(url));
    return new Response(null, { status: 204 });
  };
  store.set(TOKEN_CACHE_KEY, new Response(JSON.stringify({
    token: 'cached-access-token',
    expires_at: Date.now() + 60_000,
  })));
  const kvLog = [];
  try {
    const resp = await worker._fetch(request(), makeEnv(kvLog), ctx);
    assert.equal(resp.status, 200);
    assert.deepEqual(kvLog, [], 'warm cache must not touch KV');
    assert.deepEqual(tokenCalls, [], 'warm cache must not hit the token endpoint');
  } finally {
    globalThis.fetch = realFetch;
    store.delete(TOKEN_CACHE_KEY);
  }
});

test('warm cache with an expired entry falls back to the KV path', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url) === 'https://accounts.spotify.com/api/token'
    ? new Response(JSON.stringify({ access_token: 'synthetic-access-token' }), { status: 200 })
    : new Response(null, { status: 204 });
  store.set(TOKEN_CACHE_KEY, new Response(JSON.stringify({
    token: 'expired-token',
    expires_at: Date.now() - 1,
  })));
  const kvLog = [];
  try {
    const resp = await worker._fetch(request(), makeEnv(kvLog), ctx);
    assert.equal(resp.status, 200);
    assert.deepEqual(kvLog, ['spotify:refresh_token'], 'expired cache entry must fall through to KV');
  } finally {
    globalThis.fetch = realFetch;
    store.delete(TOKEN_CACHE_KEY);
  }
});
