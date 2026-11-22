import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROUTES = {
    steam: { title: 'Unfancy - Steam Statistiken' },
    spotify: { title: 'Unfancy - Spotify' },
    lol: { title: 'Unfancy - League of Legends' },
    socials: { title: 'Unfancy - Socials' },
};

test('each static route has unique title, canonical and OG metadata', () => {
    const titles = new Set();
    for (const [page, meta] of Object.entries(ROUTES)) {
        const html = readFileSync(join(ROOT, page, 'index.html'), 'utf8');
        assert.ok(html.includes(`<title>${meta.title}</title>`), `${page} title`);
        titles.add(meta.title);
        assert.ok(html.includes(`<link rel="canonical" href="https://nirlau.de/${page}/">`), `${page} canonical`);
        assert.equal((html.match(/rel="canonical"/g) || []).length, 1, `${page} single canonical`);
        assert.ok(html.includes(`<meta property="og:url" content="https://nirlau.de/${page}/">`), `${page} og:url`);
        assert.ok(html.includes(`<body data-static-page="${page}">`), `${page} static marker`);
        assert.ok(html.includes(`<div id="${page}" class="tab-content active">`), `${page} delivers section content statically`);
        assert.ok(html.includes('src="/js/main.js"'), `${page} uses absolute script path`);
        assert.ok(html.includes('href="/style.css"'), `${page} uses absolute stylesheet path`);
        assert.ok(!html.includes('href="style.css"'), `${page} has no relative stylesheet path`);
    }
    assert.equal(titles.size, Object.keys(ROUTES).length, 'titles are unique');
    assert.ok(!titles.has('Unfancy - Dashboard'), 'no route reuses the home title');
});

test('query compatibility: home shell still routes via ?page=', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    for (const page of Object.keys(ROUTES)) {
        assert.ok(html.includes(`href="/?page=${page}"`), `home links to ?page=${page}`);
    }
});

test('router resolves clean path deep links', async () => {
    const source = readFileSync(join(ROOT, 'js/router.js'), 'utf8');
    assert.ok(source.includes("replace(/^\\/+|\\/+$/g, '')"), 'pathname is normalised');
    assert.ok(source.includes("if (PAGE_MAP[pathPage])"), 'pathname pages are resolved');
    for (const page of Object.keys(ROUTES)) {
        assert.ok(source.includes(`'/${page}.html'`) || source.includes(`/pages/${page}.html`), `absolute fragment path for ${page}`);
    }
});

test('sitemap contains exactly the five canonical routes and is referenced by robots.txt', () => {
    const sitemap = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    assert.deepEqual(locs, [
        'https://nirlau.de/',
        'https://nirlau.de/steam/',
        'https://nirlau.de/spotify/',
        'https://nirlau.de/lol/',
        'https://nirlau.de/socials/',
    ]);
    const robots = readFileSync(join(ROOT, 'robots.txt'), 'utf8');
    assert.ok(robots.includes('Sitemap: https://nirlau.de/sitemap.xml'), 'robots references sitemap');
});

test('404 page is noindex,nofollow', () => {
    const html = readFileSync(join(ROOT, '404.html'), 'utf8');
    assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));
});

test('pages no longer reference the oversized favicon.png', () => {
    const files = ['index.html', '404.html', 'manifest.json', 'sw.js', 'steam/index.html', 'spotify/index.html', 'lol/index.html', 'socials/index.html'];
    for (const file of files) {
        const content = readFileSync(join(ROOT, file), 'utf8');
        assert.ok(!content.includes('/assets/favicon.png'), `${file} must not reference /assets/favicon.png`);
    }
});
