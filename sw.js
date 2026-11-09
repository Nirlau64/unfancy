const CACHE_NAME = 'unfancy-v3';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/style.css',
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
    '/pages/home.html',
    '/pages/steam.html',
    '/pages/spotify.html',
    '/pages/lol.html',
    '/pages/socials.html',
    '/404.html',
    '/assets/favicon.png',
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

    // Other API requests -> Network First (fallback to cache)
    if (url.hostname.includes('api.nirlau.de')) {
        e.respondWith(
            fetch(e.request)
                .then(response => {
                    const resClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
                    return response;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // Static Assets -> Cache First (fallback to network)
    e.respondWith(
        caches.match(e.request).then(cached => {
            return cached || fetch(e.request).then(response => {
                // Optionally cache new static requests dynamically
                if (e.request.method === 'GET' && url.origin === location.origin) {
                    const resClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
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
