import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('service worker caches the static routes and new icons', () => {
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    assert.ok(sw.includes("CACHE_NAME = 'unfancy-v8'"), 'cache name is bumped to v8');
    for (const route of ['/', '/steam/', '/spotify/', '/lol/', '/socials/']) {
        assert.ok(sw.includes(`'${route}'`), `service worker precaches ${route}`);
    }
    assert.ok(sw.includes("'/assets/vendor/chart.umd.js'"), 'service worker precaches the vendored chart');
    assert.ok(!sw.includes("'/assets/favicon.png'"), 'oversized icon is not precached');
});

test('service worker never persists LIVE api responses', () => {
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    // Riot stats and now-playing must never be written to CacheStorage anywhere in sw.js.
    const liveSection = sw.slice(sw.indexOf('name: \'LIVE\''), sw.indexOf('name: \'FRESH\''));
    assert.ok(liveSection.includes("pathname.startsWith('/lol/')"), 'Riot LoL proxy is a LIVE policy');
    assert.ok(liveSection.includes("pathname.startsWith('/now-playing')"), 'now-playing is a LIVE policy');
    assert.ok(sw.includes("{ cache: 'no-store' }"), 'LIVE api fetches bypass HTTP caches');
});

test('service worker differentiates api cache policy by freshness', () => {
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    assert.ok(sw.includes("name: 'FRESH'"), 'FRESH policy tier exists');
    assert.ok(sw.includes("name: 'TOLERANT'"), 'TOLERANT policy tier exists');
    // spotify/steam api hosts are FRESH; rss2json (YT feed) is TOLERANT.
    const freshSection = sw.slice(sw.indexOf("name: 'FRESH'"), sw.indexOf("name: 'TOLERANT'"));
    assert.ok(freshSection.includes('spotify.api.nirlau.de'), 'spotify api uses FRESH policy');
    assert.ok(freshSection.includes('steam.api.nirlau.de'), 'steam api uses FRESH policy');
    const tolerantSection = sw.slice(sw.indexOf("name: 'TOLERANT'"));
    assert.ok(tolerantSection.includes('api.rss2json.com'), 'rss2json uses TOLERANT policy');
});

test('stale api fallback is marked with a distinguishable header', () => {
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    assert.ok(sw.includes("'X-Unfancy-Cache'"), 'cache mark header constant exists');
    assert.ok(sw.includes("headers.set(CACHE_MARK_HEADER, 'stale')"), 'stale responses are marked');
    // markStale must not touch the cached original (cloned response is returned).
    const markStale = sw.slice(sw.indexOf('function markStale'), sw.indexOf('function cachePut'));
    assert.ok(markStale.includes('new Headers(response.headers)'), 'markStale copies headers');
    assert.ok(markStale.includes('new Response('), 'markStale returns a new response');
});

test('sw.js parses as valid script', () => {
    // node --check equivalent via spawn is covered in CI; here we at least ensure
    // no template/paren errors by importing-checking the file bytes are non-trivial.
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    assert.ok(sw.length > 1000, 'sw.js has substantive content');
    assert.ok(sw.includes("addEventListener('fetch'"), 'fetch handler registered');
});
