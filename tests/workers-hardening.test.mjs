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
