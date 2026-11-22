import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

// Minimal Cache API mock so worker rate limiting / caching code runs under node:test.
function makeCache() {
    const store = new Map();
    return {
        store,
        default: {
            match: async (req) => {
                const hit = store.get(String(req.url ?? req));
                return hit ? hit.clone() : undefined;
            },
            put: async (req, res) => { store.set(String(req.url ?? req), res.clone()); },
        },
    };
}

let caches;
// Default global cache mock; individual tests may replace it.
globalThis.caches = makeCache();

const BASE = 'https://steam.api.nirlau.de';
const steamid = '76561198159661156';

function req(path, { method = 'GET', origin } = {}) {
    const headers = new Headers();
    if (origin) headers.set('Origin', origin);
    headers.set('CF-Connecting-IP', '203.0.113.7');
    return new Request(`${BASE}${path}`, { method, headers });
}

// ---- spotify-auth ----
const auth = await import('../workers/spotify-auth.js');
const authEnv = {
    SPOTIFY_CLIENT_ID: 'client-id',
    SPOTIFY_CLIENT_SECRET: 'client-secret',
    TOKENS: {
        store: new Map(),
        async put(k, v, opts) { this.store.set(k, v); },
        async get(k, type) {
            const v = this.store.has(k) ? this.store.get(k) : null;
            return type === 'json' && typeof v === 'string' ? JSON.parse(v) : v;
        },
        async delete(k) { this.store.delete(k); },
    },
};

test('spotify-auth rejects disallowed hosts for /setup and /callback', async () => {
    const res = await auth.default.fetch(new Request('https://evil.example/setup'), authEnv);
    assert.equal(res.status, 403);
    const resCb = await auth.default.fetch(new Request('https://evil.example/callback?code=x&state=y'), authEnv);
    assert.equal(resCb.status, 403);
});

test('spotify-auth uses a fixed redirect URI and one-time state consume', async () => {
    globalThis.fetch = async (url) => new Response(JSON.stringify({ refresh_token: 'rt', access_token: 'at' }), { status: 200 });
    try {
        const first = await auth.default.fetch(new Request('https://spotify-auth.nirlau.de/setup'), authEnv);
        assert.equal(first.status, 302);
        const location = first.headers.get('Location');
        assert.ok(location.includes('redirect_uri=https%3A%2F%2Fspotify-auth.nirlau.de%2Fcallback'), 'fixed redirect URI');
        const state = new URLSearchParams(new URL(location).search).get('state');
        const code = 'authcode';

        const cb1 = await auth.default.fetch(new Request(`https://spotify-auth.nirlau.de/callback?code=${code}&state=${state}`), authEnv);
        assert.equal(cb1.status, 200);

        // Replaying the same state must be rejected (exactly-once consume).
        const cb2 = await auth.default.fetch(new Request(`https://spotify-auth.nirlau.de/callback?code=${code}&state=${state}`), authEnv);
        assert.equal(cb2.status, 400);
    } finally {
        delete globalThis.fetch;
    }
});

// ---- spotify-proxy ----
const spotify = await import('../workers/spotify-proxy.js');
const spotifyEnv = {
    SPOTIFY_CLIENT_ID: 'id',
    SPOTIFY_CLIENT_SECRET: 'secret',
    TOKENS: { get: async () => 'refresh-token' },
};
const ctx = { waitUntil: () => {} };

test('spotify-proxy: unknown origin gets no ACAO header, allowed origins are echoed', async () => {
    globalThis.caches = makeCache();
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    const bad = await spotify.default.fetch(req('/now-playing', { origin: 'https://evil.example' }), spotifyEnv, ctx);
    assert.ok(!bad.headers.has('Access-Control-Allow-Origin'), 'no ACAO for unknown origin');
    const good = await spotify.default.fetch(req('/now-playing', { origin: 'https://nirlau.de' }), spotifyEnv, ctx);
    assert.equal(good.headers.get('Access-Control-Allow-Origin'), 'https://nirlau.de');
    delete globalThis.fetch;
});

test('spotify-proxy: only GET and OPTIONS are allowed', async () => {
    const res = await spotify.default.fetch(req('/now-playing', { method: 'POST' }), spotifyEnv);
    assert.equal(res.status, 405);
    const pre = await spotify.default.fetch(req('/now-playing', { method: 'OPTIONS', origin: 'https://nirlau.de' }), spotifyEnv);
    assert.equal(pre.status, 204);
});

test('spotify-proxy: invalid range is rejected without an upstream call', async () => {
    let upstreamCalls = 0;
    globalThis.fetch = async () => { upstreamCalls++; return new Response('{}', { status: 200 }); };
    try {
        const res = await spotify.default.fetch(req('/top-tracks?range=DROP TABLE'), spotifyEnv, ctx);
        assert.equal(res.status, 400);
        assert.equal(upstreamCalls, 0);
        const ok = await spotify.default.fetch(req('/top-tracks?range=short_term'), spotifyEnv, ctx);
        assert.equal(ok.status, 200);
    } finally {
        delete globalThis.fetch;
    }
});

test('spotify-proxy: rate limit returns 429 after the configured burst', async () => {
    caches = makeCache();
    globalThis.caches = caches;
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    try {
        let status = null;
        for (let i = 0; i < 31; i++) {
            status = (await spotify.default.fetch(req('/now-playing'), spotifyEnv, ctx)).status;
        }
        assert.equal(status, 429);
    } finally {
        delete globalThis.fetch;
        globalThis.caches = makeCache();
    }
});

test('rate limiter buckets by path segment and Vary: Origin is set', async () => {
    globalThis.caches = makeCache();
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    const spotifyRes = await spotify.default.fetch(req('/now-playing'), spotifyEnv, ctx);
    assert.equal(spotifyRes.headers.get('Vary'), 'Origin');
    const steamRes = await steam.default.fetch(req(`/profile?steamid=${steamid}`), steamEnv);
    assert.equal(steamRes.headers.get('Vary'), 'Origin');
    const riotRes = await riot.default.fetch(rreq('/lol/Nirlau/Lauri/euw'), riotEnv);
    assert.equal(riotRes.headers.get('Vary'), 'Origin');
    delete globalThis.fetch;
});

test('error and rate-limit responses are not cacheable', async () => {
    globalThis.caches = makeCache();
    const notFound = await spotify.default.fetch(req('/nope'), spotifyEnv, ctx);
    assert.equal(notFound.headers.get('Cache-Control'), 'no-store');
    const steam404 = await steam.default.fetch(req(`/unknown?steamid=${steamid}`), steamEnv);
    assert.equal(steam404.headers.get('Cache-Control'), 'no-store');
    const riot404 = await riot.default.fetch(rreq('/nope'), riotEnv);
    assert.equal(riot404.headers.get('Cache-Control'), 'no-store');
});

test('rate limiter is fail-open when the cache backend fails', async () => {
    globalThis.caches = {
        default: {
            match: async () => undefined,
            put: async () => { throw new Error('cache down'); },
        },
    };
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    try {
        const res = await steam.default.fetch(req(`/profile?steamid=${steamid}`), steamEnv);
        assert.ok(res.status !== 429, 'request is served despite cache failure');
        const riotRes = await riot.default.fetch(rreq('/'), riotEnv);
        assert.ok(riotRes.status !== 429, 'riot request is served despite cache failure');
    } finally {
        delete globalThis.fetch;
        globalThis.caches = makeCache();
    }
});

test('429 responses carry Cache-Control: no-store', async () => {
    globalThis.caches = makeCache();
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    try {
        let last = null;
        for (let i = 0; i < 31; i++) {
            last = await steam.default.fetch(req(`/profile?steamid=${steamid}`), steamEnv);
        }
        assert.equal(last.headers.get('Cache-Control'), 'no-store');
    } finally {
        delete globalThis.fetch;
        globalThis.caches = makeCache();
    }
});

test('spotify-proxy /refresh-check forces a fresh KV-backed token exchange', async () => {
    globalThis.caches = makeCache();
    // Pre-warm the v2 cache: refresh-check must ignore it.
    await caches.default.put(
        new Request('https://spotify-token-cache.local/access_token/v2'),
        new Response(JSON.stringify({ token: 'cached-token', expires_at: Date.now() + 999999 }), {
            headers: { 'Cache-Control': 'public, max-age=3300' }
        })
    );
    let kvRead = false;
    const spotifyEnvProbe = {
        SPOTIFY_CLIENT_ID: 'id',
        SPOTIFY_CLIENT_SECRET: 'secret',
        TOKENS: {
            get: async () => { kvRead = true; return 'refresh-token'; },
        },
    };
    globalThis.fetch = async (url, init) => {
        if (String(url).includes('accounts.spotify.com/api/token')) {
            return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
    };
    try {
        const res = await spotify.default.fetch(req('/refresh-check'), spotifyEnvProbe, ctx);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body, { ok: true, source: 'kv' });
        assert.ok(kvRead, 'refresh-check performed a real KV read');
        // No token material in the response.
        assert.ok(!JSON.stringify(body).includes('fresh'));
    } finally {
        delete globalThis.fetch;
        globalThis.caches = makeCache();
    }
});

// ---- steam-proxy ----
const steam = await import('../workers/steam-proxy.js');
const steamEnv = { STEAM_API_KEY: 'k' };

test('steam-proxy: invalid steamid is rejected without an upstream call', async () => {
    let upstreamCalls = 0;
    globalThis.fetch = async () => { upstreamCalls++; return new Response('{}', { status: 200 }); };
    try {
        for (const bad of ['1', '<script>', '12345678901234567x', '']) {
            const res = await steam.default.fetch(req(`/profile?steamid=${encodeURIComponent(bad)}`), steamEnv);
            assert.equal(res.status, 400, `steamid "${bad}" rejected`);
        }
        assert.equal(upstreamCalls, 0);
    } finally {
        delete globalThis.fetch;
    }
});

test('steam-proxy: only GET and OPTIONS are allowed, CORS is allowlisted', async () => {
    const post = await steam.default.fetch(req(`/owned?steamid=${steamid}`, { method: 'POST' }), steamEnv);
    assert.equal(post.status, 405);
    const bad = await steam.default.fetch(req(`/owned?steamid=${steamid}`, { origin: 'https://evil.example' }), steamEnv);
    assert.ok(!bad.headers.has('Access-Control-Allow-Origin'));
    const pre = await steam.default.fetch(req(`/owned?steamid=${steamid}`, { method: 'OPTIONS', origin: 'https://www.nirlau.de' }), steamEnv);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://www.nirlau.de');
});

test('steam-proxy: upstream errors do not leak internals', async () => {
    globalThis.fetch = async () => { throw new Error('internal-host-name.internal'); };
    try {
        const res = await steam.default.fetch(req(`/profile?steamid=${steamid}`), steamEnv);
        assert.equal(res.status, 502);
        const body = await res.json();
        assert.deepEqual(Object.keys(body), ['error']);
        assert.ok(!JSON.stringify(body).includes('internal-host-name'));
    } finally {
        delete globalThis.fetch;
    }
});

test('steam-proxy: rate limit returns 429 after the configured burst and buckets per route', async () => {
    globalThis.caches = makeCache();
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    try {
        let status = null;
        for (let i = 0; i < 31; i++) {
            status = (await steam.default.fetch(req(`/profile?steamid=${steamid}`), steamEnv)).status;
        }
        assert.equal(status, 429);
        // A different first path segment has its own bucket.
        const other = await steam.default.fetch(req(`/owned?steamid=${steamid}`), steamEnv);
        assert.ok(other.status !== 429, 'separate bucket for a different path segment');
    } finally {
        delete globalThis.fetch;
        globalThis.caches = makeCache();
    }
});

test('steam-proxy: rate limit buckets are per client IP', async () => {
    globalThis.caches = makeCache();
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    try {
        for (let i = 0; i < 30; i++) {
            await steam.default.fetch(req(`/profile?steamid=${steamid}`), steamEnv);
        }
        assert.equal((await steam.default.fetch(req(`/profile?steamid=${steamid}`), steamEnv)).status, 429);
        const otherHeaders = new Headers();
        otherHeaders.set('CF-Connecting-IP', '198.51.100.9');
        const other = await steam.default.fetch(new Request(`${BASE}/profile?steamid=${steamid}`, { headers: otherHeaders }), steamEnv);
        assert.ok(other.status !== 429, 'second IP has its own bucket');
    } finally {
        delete globalThis.fetch;
        globalThis.caches = makeCache();
    }
});

// ---- riot-proxy ----
const riot = await import('../workers/riot-proxy.js');
const riotEnv = { RIOT_API_KEY: 'k' };
const RBASE = 'https://api.nirlau.de';

function rreq(path, { method = 'GET', origin } = {}) {
    const headers = new Headers();
    if (origin) headers.set('Origin', origin);
    headers.set('CF-Connecting-IP', '203.0.113.9');
    return new Request(`${RBASE}${path}`, { method, headers });
}

test('riot-proxy: only GET and OPTIONS are allowed', async () => {
    const res = await riot.default.fetch(rreq('/lol/Nirlau/Lauri/euw', { method: 'POST' }), riotEnv);
    assert.equal(res.status, 405);
    const pre = await riot.default.fetch(rreq('/lol', { method: 'OPTIONS', origin: 'https://nirlau.de' }), riotEnv);
    assert.equal(pre.status, 204);
});

test('riot-proxy: unknown origin gets no ACAO header', async () => {
    globalThis.caches = makeCache();
    const res = await riot.default.fetch(rreq('/', { origin: 'https://evil.example' }), riotEnv);
    assert.ok(!res.headers.has('Access-Control-Allow-Origin'));
    const ok = await riot.default.fetch(rreq('/', { origin: 'https://nirlau.de' }), riotEnv);
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://nirlau.de');
});

test('riot-proxy: invalid names, tags and regions are rejected without upstream calls', async () => {
    let upstreamCalls = 0;
    globalThis.fetch = async () => { upstreamCalls++; return new Response('{}', { status: 200 }); };
    try {
        for (const path of ['/lol/bad%3Cscript%3E/Lauri/euw', '/lol/Nirlau/L4ur1%2F/euw', '/lol/Nirlau/Lauri/mars', '/lol/a/b']) {
            const res = await riot.default.fetch(rreq(path), riotEnv);
            assert.equal(res.status, 400, `${path} rejected`);
        }
        assert.equal(upstreamCalls, 0);
        const valid = await riot.default.fetch(rreq('/lol/Nirlau/Lauri/euw'), riotEnv);
        assert.ok(valid.status >= 200, 'valid request reaches upstream handling');
    } finally {
        delete globalThis.fetch;
    }
});

test('riot-proxy: rate limit returns 429 after the configured burst', async () => {
    caches = makeCache();
    globalThis.caches = caches;
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    try {
        let status = null;
        for (let i = 0; i < 31; i++) {
            status = (await riot.default.fetch(rreq('/'), riotEnv)).status;
        }
        assert.equal(status, 429);
    } finally {
        delete globalThis.fetch;
        globalThis.caches = makeCache();
    }
});
