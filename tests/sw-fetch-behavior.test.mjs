// Behavioral test: evaluates sw.js in a sandbox with a mock CacheStorage and
// exercises the differentiated API fetch policies end-to-end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW_SOURCE = readFileSync(join(ROOT, 'sw.js'), 'utf8');

const { Request, Response, Headers } = globalThis;

function makeSandbox() {
    const store = new Map(); // cacheName -> Map(url -> Response)
    const caches = {
        open: async (name) => {
            if (!store.has(name)) store.set(name, new Map());
            const entries = store.get(name);
            return {
                match: async (req) => entries.get(new URL(req.url).toString()) ? cloneResponse(entries.get(new URL(req.url).toString())) : undefined,
                put: async (req, res) => { entries.set(new URL(req.url).toString(), cloneResponse(res)); },
            };
        },
        keys: async () => [...store.keys()],
        delete: async (name) => store.delete(name),
        match: async (req) => {
            for (const entries of store.values()) {
                if (entries.has(new URL(req.url).toString())) {
                    return cloneResponse(entries.get(new URL(req.url).toString()));
                }
            }
            return undefined;
        },
        _store: store,
    };
    let networkFail = false;
    const sandbox = {
        console,
        URL,
        Date,
        Request,
        Response,
        Headers,
        fetch: async (req) => {
            if (networkFail) throw new TypeError('Failed to fetch');
            const url = new URL(req.url);
            return new Response(JSON.stringify({ url: url.toString() }), {
                status: 200,
                headers: { 'content-type': 'application/json', 'date': new Date().toUTCString() },
            });
        },
        caches,
        location: { origin: 'https://nirlau.de' },
        clients: { claim: async () => {} },
        self: null, // set below
        networkFailRef: { get fail() { return networkFail; }, set fail(v) { networkFail = v; } },
    };
    const listeners = {};
    sandbox.self = {
        addEventListener: (name, fn) => { listeners[name] = fn; },
        skipWaiting: async () => {},
        registration: {},
    };
    sandbox.__listeners = listeners;
    vm.createContext(sandbox);
    vm.runInContext(SW_SOURCE, sandbox);
    return sandbox;
}

function cloneResponse(res) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function makeFetchEvent(request) {
    const props = { responded: null, waits: [] };
    const event = {
        request,
        get responded() { return props.responded; },
        respondWith: (p) => { props.responded = p; },
        waitUntil: (p) => { props.waits.push(Promise.resolve(p).catch(() => {})); },
        _props: props,
    };
    return event;
}

test('LIVE api responses are fetched no-store and never cached', async () => {
    const sb = makeSandbox();
    const req = new Request('https://api.nirlau.de/lol/Nirlau/Lauri/euw');
    const event = makeFetchEvent(req);
    sb.__listeners.fetch(event);
    const res = await event.responded;
    assert.equal(res.status, 200);
    const entries = sb.caches._store.get('unfancy-v8');
    assert.ok(!entries || entries.size === 0, 'LIVE response is not persisted');
});

test('FRESH policy caches steam responses and marks stale fallback', async () => {
    const sb = makeSandbox();
    const url = 'https://steam.api.nirlau.de/profile?steamid=76561198159661156';
    // 1. Warm pass: network success persists the response.
    const warmEvent = makeFetchEvent(new Request(url));
    sb.__listeners.fetch(warmEvent);
    const warm = await warmEvent.responded;
    assert.equal(warm.status, 200);
    assert.ok(!warm.headers.get('X-Unfancy-Cache'), 'fresh network response is unmarked');
    // 2. Age the cached copy beyond maxAgeMs (60s), then fail the network.
    const entries = sb.caches._store.get('unfancy-v8');
    const cached = entries.get(new URL(url).toString());
    const aged = new Response(await cached.clone().arrayBuffer(), {
        status: cached.status,
        headers: { 'date': new Date(Date.now() - 5 * 60 * 1000).toUTCString() },
    });
    entries.set(new URL(url).toString(), aged);
    sb.networkFailRef.fail = true;
    const staleEvent = makeFetchEvent(new Request(url));
    sb.__listeners.fetch(staleEvent);
    const stale = await staleEvent.responded;
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('X-Unfancy-Cache'), 'stale', 'fallback is marked stale');
    sb.networkFailRef.fail = false;
});

test('TOLERANT policy serves cached rss2json with background revalidate', async () => {
    const sb = makeSandbox();
    const url = 'https://api.rss2json.com/v1/api.json?rss_url=x';
    const warmEvent = makeFetchEvent(new Request(url));
    sb.__listeners.fetch(warmEvent);
    const warm = await warmEvent.responded;
    assert.equal(warm.status, 200);
    // Second hit with cache present: served from cache (fresh window), revalidate in background.
    const hitEvent = makeFetchEvent(new Request(url));
    sb.__listeners.fetch(hitEvent);
    const hit = await hitEvent.responded;
    assert.equal(hit.status, 200);
    assert.ok(!hit.headers.get('X-Unfancy-Cache'), 'fresh cached response is unmarked');
    await Promise.all(hitEvent._props.waits);
    assert.ok(sb.caches._store.get('unfancy-v8').has(new URL(url).toString()), 'cache still populated');
});

test('stale TOLERANT fallback is marked when maxAge exceeded', async () => {
    const sb = makeSandbox();
    const url = 'https://api.rss2json.com/v1/api.json?rss_url=x';
    // Warm cache, then artificially age the cached copy beyond maxAgeMs (10 min).
    const warmEvent = makeFetchEvent(new Request(url));
    sb.__listeners.fetch(warmEvent);
    await warmEvent.responded;
    const entries = sb.caches._store.get('unfancy-v8');
    const old = entries.get(new URL(url).toString());
    const aged = new Response(await old.clone().arrayBuffer(), {
        status: old.status,
        headers: { 'date': new Date(Date.now() - 20 * 60 * 1000).toUTCString() },
    });
    entries.set(new URL(url).toString(), aged);
    sb.networkFailRef.fail = true;
    const staleEvent = makeFetchEvent(new Request(url));
    sb.__listeners.fetch(staleEvent);
    const stale = await staleEvent.responded;
    assert.equal(stale.headers.get('X-Unfancy-Cache'), 'stale', 'aged fallback is marked stale');
});

test('unlisted api hosts are never cached (no-store passthrough)', async () => {
    const sb = makeSandbox();
    const event = makeFetchEvent(new Request('https://unknown.api.nirlau.de/thing'));
    sb.__listeners.fetch(event);
    const res = await event.responded;
    assert.equal(res.status, 200);
    const entries = sb.caches._store.get('unfancy-v8');
    assert.ok(!entries || [...entries.values()].length === 0, 'unlisted api host not persisted');
});

test('non-api static asset handling still works (cache-first, persist same-origin)', async () => {
    const sb = makeSandbox();
    const url = 'https://nirlau.de/style.css';
    const event = makeFetchEvent(new Request(url));
    sb.__listeners.fetch(event);
    const res = await event.responded;
    assert.equal(res.status, 200);
    assert.ok(sb.caches._store.get('unfancy-v8').has(new URL(url).toString()), 'same-origin asset persisted');
});
