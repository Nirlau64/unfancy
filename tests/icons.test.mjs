import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ICONS = {
    'favicon-64.png': 64,
    'icon-192.png': 192,
    'icon-512.png': 512,
    'apple-touch-icon.png': 180,
};

test('referenced icons exist and stay within the transfer budget', () => {
    let total = 0;
    for (const [name] of Object.entries(ICONS)) {
        const stat = statSync(join(ROOT, 'assets', name));
        assert.ok(stat.isFile(), `${name} exists`);
        total += stat.size;
    }
    assert.ok(total < 100 * 1024, `all referenced icons together are under 100 KB (got ${total} bytes)`);
});

test('manifest icons point at existing, correctly dimensioned files', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    const entries = manifest.icons.map(icon => ({ src: icon.src, sizes: icon.sizes }));
    assert.deepEqual(entries, [
        { src: '/assets/favicon-64.png', sizes: '64x64' },
        { src: '/assets/icon-192.png', sizes: '192x192' },
        { src: '/assets/icon-512.png', sizes: '512x512' },
    ]);
    for (const entry of entries) {
        assert.ok(statSync(join(ROOT, entry.src)).isFile(), `${entry.src} exists`);
        const size = Number(entry.sizes.split('x')[0]);
        const expected = ICONS[entry.src.split('/').pop()];
        assert.equal(size, expected, `${entry.src} declared size matches generated size`);
    }
    // No duplicate icon sources.
    assert.equal(new Set(entries.map(e => e.src)).size, entries.length, 'no duplicate manifest icons');
});

test('Chart.js is vendored locally at the pinned version', () => {
    const chart = readFileSync(join(ROOT, 'assets/vendor/chart.umd.js'), 'utf8');
    assert.ok(chart.includes('version="4.4.7"'), 'Chart.js 4.4.7 is vendored');
    const steam = readFileSync(join(ROOT, 'js/views/steam.js'), 'utf8');
    assert.ok(steam.includes("'/assets/vendor/chart.umd.js'"), 'steam view loads the local build');
    assert.ok(!steam.includes('cdn.jsdelivr.net'), 'steam view no longer loads Chart.js from a CDN');
    const index = readFileSync(join(ROOT, 'index.html'), 'utf8');
    assert.ok(!index.includes('cdn.jsdelivr.net'), 'home shell no longer allowlists jsdelivr');
});
