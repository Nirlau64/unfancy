import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('service worker caches the static routes and new icons', () => {
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    assert.ok(sw.includes("CACHE_NAME = 'unfancy-v7'"), 'cache name is bumped to v7');
    for (const route of ['/', '/steam/', '/spotify/', '/lol/', '/socials/']) {
        assert.ok(sw.includes(`'${route}'`), `service worker precaches ${route}`);
    }
    assert.ok(sw.includes("'/assets/vendor/chart.umd.js'"), 'service worker precaches the vendored chart');
    assert.ok(!sw.includes("'/assets/favicon.png'"), 'oversized icon is not precached');
});

test('service worker never persists API responses', () => {
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    const apiBlock = sw.slice(sw.indexOf("url.hostname.includes('api.nirlau.de')"), sw.indexOf('// Static Assets'));
    assert.ok(!apiBlock.includes('cache.put'), 'API responses are not written to CacheStorage');
    assert.ok(sw.includes("{ cache: 'no-store' }"), 'API fetches bypass HTTP caches');
});

test('steam chart lifecycle guards', () => {
    const steam = readFileSync(join(ROOT, 'js/views/steam.js'), 'utf8');
    assert.ok(steam.includes('CHARTJS_LOAD_TIMEOUT_MS = 5000'), 'chart load is time-limited');
    assert.ok(steam.includes('setTimeout(() => reject'), 'load timeout rejects the promise');
    assert.ok(steam.includes('if (!chartCanvas.isConnected) return;'), 'no chart on a detached canvas');
    assert.ok(steam.includes('renderChart(sortedGames, totalMins)'), 'chart is rendered after the data render');
    // Chart.js must be requested only from within renderSteamStats call chain (after data arrives).
    const loadIdx = steam.indexOf('renderChart(sortedGames');
    assert.ok(loadIdx > 0, 'renderChart is invoked from the stats renderer');
});
