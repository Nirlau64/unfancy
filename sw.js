const CACHE_NAME = 'unfancy-v7';
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

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Riot stats and metadata must not be persisted; always bypass HTTP and CacheStorage caches.
    const isRiotResource = (url.hostname === 'api.nirlau.de' && url.pathname.startsWith('/lol/'))
        || url.hostname === 'riotgames.com'
        || url.hostname.endsWith('.riotgames.com');
    if (isRiotResource) {
        e.respondWith(fetch(new Request(e.request, { cache: 'no-store' })));
        return;
    }

    // API responses are private/dynamic; never persist them in CacheStorage.
    if (url.hostname.includes('api.nirlau.de')) {
        e.respondWith(fetch(new Request(e.request, { cache: 'no-store' })));
        return;
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
