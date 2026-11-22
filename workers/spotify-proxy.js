const ALLOWED_ORIGINS = ['https://nirlau.de', 'https://www.nirlau.de'];

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const NOW_PLAYING_ENDPOINT = 'https://api.spotify.com/v1/me/player/currently-playing';
const TOP_ARTISTS_ENDPOINT = 'https://api.spotify.com/v1/me/top/artists';
const TOP_TRACKS_ENDPOINT = 'https://api.spotify.com/v1/me/top/tracks';

const VALID_RANGES = new Set(['short_term', 'medium_term', 'long_term']);

// Simple abuse guard: fixed window per client IP, backed by the Cache API.
const RATE_LIMIT = 30; // requests
const RATE_WINDOW_SECONDS = 60;

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  // An unknown or missing Origin never receives an ACAO header.
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  headers['Vary'] = 'Origin';
  return headers;
}

function allowedOrigin(request) {
  const reqOrigin = request.headers.get('Origin');
  return reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : null;
}

function json(data, status = 200, origin = null) {
  const headers = corsHeaders(origin);
  // Errors, 404s and rate-limit responses must never be cached.
  if (status !== 200) headers['Cache-Control'] = 'no-store';
  return new Response(JSON.stringify(data), { status, headers });
}

async function rateLimit(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const url = new URL(request.url);
  // Bucket by client IP and first path segment so different routes do not
  // share a counter. Window rollover happens implicitly via the cache TTL.
  const window = Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));
  const bucket = url.pathname.split('/').filter(Boolean)[0] || 'root';
  const key = new Request(`https://rate-limit.local/spotify-proxy/${ip}/${bucket}/${window}`);
  // The limiter is a best-effort guard, not a correctness feature: if the
  // cache backend fails, requests must still be served (fail-open).
  try {
    const cached = await caches.default.match(key);
    const count = cached ? Number(await cached.text()) || 0 : 0;
    if (count >= RATE_LIMIT) return false;
    const counter = new Response(String(count + 1));
    counter.headers.set('Cache-Control', `public, max-age=${RATE_WINDOW_SECONDS}`);
    await caches.default.put(key, counter);
    return true;
  } catch {
    return true;
  }
}

/**
 * Holt einen Spotify Access Token, gecached für 55 Minuten (3300s).
 */
async function exchangeRefreshToken(env, refreshToken) {
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!resp.ok) return { error: true, status: resp.status };
  const body = await resp.json();
  if (!body?.access_token) return { error: true, status: resp.status };
  return { error: false, token: body.access_token };
}

async function getAccessToken(env, ctx) {
  // Key is versioned per source revision so a deploy always starts with a cold
  // token cache: the first request after a deploy provably exercises the KV
  // refresh-token path.
  const CACHE_KEY = 'https://spotify-token-cache.local/access_token/v2';

  {
    const cached = await caches.default.match(CACHE_KEY);
    if (cached) {
      const data = await cached.json();
      if (data.expires_at > Date.now()) {
        return { error: false, token: data.token };
      }
    }
  }

  const result = await exchangeRefreshToken(env, await env.TOKENS.get('spotify:refresh_token'));
  if (result.error) return result;
  const token = result.token;

  const cacheResp = new Response(JSON.stringify({
    token,
    expires_at: Date.now() + 3300 * 1000,
  }));
  cacheResp.headers.set('Cache-Control', 'public, max-age=3300');
  ctx.waitUntil(caches.default.put(CACHE_KEY, cacheResp));

  return { error: false, token };
}

async function fetchSpotify(url, token, ctx, cacheTtl = 0) {
  if (cacheTtl > 0) {
    const cacheKey = new Request(url);
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached.clone();
  }

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (cacheTtl > 0 && resp.ok) {
    const cloned = new Response(resp.body, resp);
    cloned.headers.set('Cache-Control', `public, max-age=${cacheTtl}`);
    ctx.waitUntil(caches.default.put(new Request(url), cloned.clone()));
    return cloned;
  }

  return resp;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch {
      // Any unexpected failure (e.g. KV read rejected) answers in a controlled way.
      return json({ error: 'Internal error' }, 500, null);
    }
  },
};

async function handleRequest(request, env, ctx) {
    const origin = allowedOrigin(request);

    if (request.method === 'OPTIONS') {
      const headers = corsHeaders(origin);
      headers['Cache-Control'] = 'no-store';
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, origin);
    }
    if (!(await rateLimit(request))) {
      return json({ error: 'Too many requests' }, 429, origin);
    }

    const url = new URL(request.url);

    if (url.pathname === '/now-playing') {
      const tokenResp = await getAccessToken(env, ctx);
      if (tokenResp.error) {
        return json({ error: 'Spotify API temporarily unavailable' }, 502, origin);
      }
      const apiResp = await fetchSpotify(NOW_PLAYING_ENDPOINT, tokenResp.token, ctx, 0);
      if (apiResp.status === 204) return json({ is_playing: false }, 200, origin);
      if (!apiResp.ok) return json({ error: 'Spotify API error' }, apiResp.status, origin);
      return json(await apiResp.json(), 200, origin);
    }

    // Diagnostic endpoint: forces a fresh access-token exchange (bypasses the
    // token cache) and reports success without ever returning token material.
    // Proves the KV refresh-token path is intact before/after binding changes.
    // Hardened: gated by a secret diagnostic token header, requires the KV
    // refresh token to be present, always no-store; scheduled for removal in a
    // follow-up deploy after binding-change verification.
    if (url.pathname === '/refresh-check') {
      if (!env.DIAG_TOKEN || request.headers.get('x-diag-token') !== env.DIAG_TOKEN) {
        return json({ error: 'Not found' }, 404, origin);
      }
      let refreshToken;
      try {
        refreshToken = await env.TOKENS.get('spotify:refresh_token');
      } catch {
        return json({ ok: false, error: 'kv read failed' }, 502, origin);
      }
      if (!refreshToken) {
        return json({ ok: false, error: 'no refresh token in KV' }, 502, origin);
      }
      // Exactly one KV read; the exchange uses exactly this value.
      let tokenResp;
      try {
        tokenResp = await exchangeRefreshToken(env, refreshToken);
      } catch {
        return json({ ok: false, error: 'token exchange failed' }, 502, origin);
      }
      if (tokenResp.error || !tokenResp.token) {
        return json({ ok: false, error: 'token exchange failed' }, 502, origin);
      }
      return new Response(JSON.stringify({ ok: true, source: 'kv' }), {
        status: 200,
        headers: { ...corsHeaders(origin), 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/top-artists' || url.pathname === '/top-tracks') {
      const timeRange = url.searchParams.get('range') || 'medium_term';
      if (!VALID_RANGES.has(timeRange)) {
        return json({ error: 'Invalid range. Use short_term, medium_term, or long_term' }, 400, origin);
      }
      const tokenResp = await getAccessToken(env, ctx);
      if (tokenResp.error) {
        return json({ error: 'Spotify API temporarily unavailable' }, 502, origin);
      }
      const limit = 12;
      const baseEndpoint = url.pathname === '/top-artists' ? TOP_ARTISTS_ENDPOINT : TOP_TRACKS_ENDPOINT;
      const spotifyUrl = `${baseEndpoint}?time_range=${timeRange}&limit=${limit}`;
      const apiResp = await fetchSpotify(spotifyUrl, tokenResp.token, ctx, 600);
      if (!apiResp.ok) return json({ error: 'Spotify API error' }, apiResp.status, origin);
      return json(await apiResp.json(), 200, origin);
    }

    return json({ error: 'Invalid endpoint. Use /now-playing, /top-artists, or /top-tracks' }, 404, origin);
}
