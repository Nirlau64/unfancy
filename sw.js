const CACHE_NAME = 'unfancy-v8';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/style.css',
    '/steam/',
    '/spotify/',
    '/lol/',
    '/socials/',
    '/js/main.js',
    '/js/router.js',
    '/js/api.js',
    '/js/utils.js',
    '/js/lol-data.mjs',
    '/js/views/home.js',
    '/js/views/steam.js',
    '/js/views/spotify.js',
    '/js/views/lol.js',
    '/js/views/socials.js',
    // Page fragments are warmed after the first render instead of during install.
    '/404.html',
    '/assets/favicon-64.png',
    '/assets/icon-192.png',
    '/assets/icon-512.png',
    '/assets/apple-touch-icon.png',
    '/assets/vendor/chart.umd.js',
    'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&display=swap'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            cache.addAll(STATIC_ASSETS.map(asset => new Request(asset, { cache: 'reload' })))
        )
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// ---------------------------------------------------------------------------
// API cache policy by data freshness.
//
// LIVE     – realtime data (now-playing) and Riot/LoL stats: never persisted,
//            always fetched with `no-store`, no stale fallback.
// FRESH    – short-lived data (Spotify top lists, Steam): network-first with
//            a short-lived cache copy; on network failure the cached response
//            is served but marked stale via the `X-Unfancy-Cache` header.
// TOLERANT – slow-changing data (YouTube feed via rss2json):
//            stale-while-revalidate, stale fallback marked like FRESH.
// ---------------------------------------------------------------------------
const CACHE_MARK_HEADER = 'X-Unfancy-Cache';

const API_POLICIES = [
    {
        name: 'LIVE',
        match: (url) => (url.hostname === 'api.nirlau.de' && url.pathname.startsWith('/lol/'))
            || url.hostname === 'riotgames.com'
            || url.hostname.endsWith('.riotgames.com')
            || (url.hostname === 'spotify.api.nirlau.de' && url.pathname.startsWith('/now-playing')),
        // Never cached, never persisted.
    },
    {
        name: 'FRESH',
        match: (url) => url.hostname === 'spotify.api.nirlau.de'
            || url.hostname === 'steam.api.nirlau.de',
        maxAgeMs: 60 * 1000,
    },
    {
        name: 'TOLERANT',
        match: (url) => url.hostname === 'api.rss2json.com',
        maxAgeMs: 10 * 60 * 1000,
    },
];

const isApiGet = (request) => request.method === 'GET';

function apiPolicyFor(url) {
    return API_POLICIES.find((policy) => policy.match(url)) || null;
}

function isFresh(response, maxAgeMs) {
    const cachedAtMs = Date.parse(response.headers.get('date') || '');
    if (!Number.isFinite(cachedAtMs)) return false;
    return Date.now() - cachedAtMs <= maxAgeMs;
}

function markStale(response) {
    const headers = new Headers(response.headers);
    headers.set(CACHE_MARK_HEADER, 'stale');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function cachePut(cache, request, response) {
    return cache.put(request, response.clone()).catch(() => {});
}

// Network-first with fresh-aware stale fallback (FRESH/TOLERANT policies).
function networkFirstWithStaleFallback(request, policy) {
    return caches.open(CACHE_NAME).then(cache =>
        fetch(new Request(request, { cache: 'no-store' })).then(response => {
            if (response.ok) cachePut(cache, request, response);
            return response;
        }).catch(() =>
            cache.match(request).then(cached => {
                if (!cached) return Response.error();
                if (isFresh(cached, policy.maxAgeMs)) return cached;
                return markStale(cached);
            })
        )
    );
}

// Stale-while-revalidate (TOLERANT policy): serve fast, refresh in background.
function staleWhileRevalidate(event, request, policy) {
    return caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
            const network = fetch(new Request(request, { cache: 'no-store' }))
                .then(response => {
                    if (response.ok) cachePut(cache, request, response);
                    return response;
                })
                .catch(() => null);
            if (cached) {
                event.waitUntil(network.catch(() => {}));
                if (isFresh(cached, policy.maxAgeMs)) return cached;
                return markStale(cached);
            }
            return network.then(response => response || Response.error());
        })
    );
}

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Non-GET API requests: never cached, bypass HTTP and CacheStorage caches.
    if (e.request.method !== 'GET' && (url.hostname === 'api.nirlau.de' || url.hostname.endsWith('.api.nirlau.de'))) {
        e.respondWith(fetch(new Request(e.request, { cache: 'no-store' })));
        return;
    }

    // API responses are private/dynamic; persist only per freshness policy.
    if (isApiGet(e.request)) {
        const policy = apiPolicyFor(url);
        if (policy) {
            if (policy.name === 'LIVE') {
                e.respondWith(fetch(new Request(e.request, { cache: 'no-store' })));
            } else if (policy.name === 'FRESH') {
                e.respondWith(networkFirstWithStaleFallback(e.request, policy));
            } else {
                e.respondWith(staleWhileRevalidate(e, e.request, policy));
            }
            return;
        }
        // Unlisted API hosts on nirlau.de: bypass HTTP and CacheStorage caches.
        // Other cross-origin resources (e.g. fonts) keep the static cache-first path.
        if (url.hostname === 'api.nirlau.de' || url.hostname.endsWith('.api.nirlau.de')) {
            e.respondWith(fetch(new Request(e.request, { cache: 'no-store' })));
            return;
        }
    }

    // Static Assets -> Cache First (fallback to network)
    e.respondWith(
        caches.match(e.request).then(cached => {
            return cached || fetch(e.request).then(response => {
                // Persist same-origin GETs, including idle-prefetched page fragments.
                if (response.ok && e.request.method === 'GET' && url.origin === location.origin) {
                    return caches.open(CACHE_NAME)
                        .then(cache => cache.put(e.request, response.clone()))
                        .then(() => response)
                        .catch(() => response);
                }
                return response;
            });
        }).catch(() => {
            // Offline fallback
            if (e.request.destination === 'document') {
                return caches.match('/');
            }
        })
    );
});
