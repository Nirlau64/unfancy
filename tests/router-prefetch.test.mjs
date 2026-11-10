import assert from 'node:assert/strict';
import { test } from 'node:test';

const router = await import('../js/router.js?idle-prefetch-test');

const expectedFragments = [
    'pages/steam.html',
    'pages/spotify.html',
    'pages/lol.html',
    'pages/socials.html'
];

test('idle preloader fetches each uncached route once and reuses its cache', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (input) => {
        requests.push(String(input));
        await new Promise(resolve => setTimeout(resolve, 5));
        return new Response(`<section data-path="${input}"></section>`, { status: 200 });
    };

    try {
        router.preCachePage('home', '<div id="home"></div>');
        await Promise.all([
            router.preloadPageFragments(),
            router.preloadPageFragments()
        ]);

        assert.deepEqual(
            requests.map(url => url.replace(/^\//, '')).sort(),
            expectedFragments.slice().sort()
        );

        requests.length = 0;
        await router.preloadPageFragments();
        assert.deepEqual(requests, []);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('a failed fragment prefetch is retryable on the next idle run', async () => {
    const retryRouter = await import('../js/router.js?idle-prefetch-retry-test');
    const originalFetch = globalThis.fetch;
    const attempts = new Map();
    globalThis.fetch = async (input) => {
        const url = String(input);
        const attempt = (attempts.get(url) || 0) + 1;
        attempts.set(url, attempt);
        if (url.endsWith('pages/steam.html') && attempt === 1) {
            return new Response('temporary failure', { status: 503 });
        }
        return new Response(`<section data-path="${url}"></section>`, { status: 200 });
    };

    try {
        await retryRouter.preloadPageFragments();
        assert.equal(attempts.get('pages/steam.html'), 1);
        await retryRouter.preloadPageFragments();
        assert.equal(attempts.get('pages/steam.html'), 2);
        for (const path of expectedFragments.slice(1)) {
            assert.equal(attempts.get(path), 1);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});
