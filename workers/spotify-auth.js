import { logInvocation } from './invocation-logging.js';
const SPOTIFY_AUTHORIZE = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN = 'https://accounts.spotify.com/api/token';
const SCOPES = 'user-read-currently-playing user-top-read';
const STATE_TTL_SECONDS = 600;
const REFRESH_TOKEN_KEY = 'spotify:refresh_token';
const ISSUED_AT_KEY = 'spotify:authorized_at';

// Match the parsed hostname exactly; never use suffix/prefix or wildcard checks.
const ALLOWED_HOSTS = new Set(['spotify-auth.nirlau.de']);
const CALLBACK_URL = 'https://spotify-auth.nirlau.de/callback';

function html(body, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Spotify-Verbindung</title><main style="font-family:system-ui;max-width:42rem;margin:4rem auto;padding:1rem;background:#111;color:#eee">${body}</main>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function redirectUri() {
  return CALLBACK_URL;
}

function originAllowed(request) {
  const url = new URL(request.url);
  return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.host);
}

function randomState() {
  return crypto.randomUUID();
}

function randomVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function setupPage(request, env) {
  if (request.method !== 'GET') return html('<p>Method not allowed.</p>', 405);
  if (!originAllowed(request)) return html('<h1>Spotify</h1><p>Nicht erlaubter Host.</p>', 403);
  // Never allow OAuth setup to replace the shared refresh token without an
  // explicit secret binding. Accept it only in a header: query strings leak
  // into browser history, analytics, and request logs.
  const configuredToken = typeof env.SETUP_TOKEN === 'string' ? env.SETUP_TOKEN : '';
  const providedToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!configuredToken || !providedToken || !timingSafeEqual(providedToken, configuredToken)) {
    return html('<h1>Spotify</h1><p>Setup-Zugang verweigert.</p>', 403);
  }

  const verifier = randomVerifier();
  const challenge = await codeChallenge(verifier);
  const state = randomState();
  await env.TOKENS.put(`oauth:state:${state}`, JSON.stringify({ verifier }), { expirationTtl: STATE_TTL_SECONDS });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  return Response.redirect(`${SPOTIFY_AUTHORIZE}?${params}`, 302);
}

async function callback(request, env) {
  if (!originAllowed(request)) return html('<h1>Spotify</h1><p>Nicht erlaubter Host.</p>', 403);

  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) return html(`<h1>Spotify</h1><p>Autorisierung nicht abgeschlossen: ${escapeHtml(error)}</p>`, 400);

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code) return html('<h1>Spotify</h1><p>OAuth-Antwort unvollständig.</p>', 400);

  const stateKey = `oauth:state:${state}`;
  const statePayload = await env.TOKENS.get(stateKey, 'json');
  if (!statePayload?.verifier) return html('<h1>Spotify</h1><p>OAuth-Zustand ungültig oder abgelaufen.</p>', 400);
  // Single-use consume: the state is deleted immediately after the read so a
  // replayed callback no longer finds it. NOTE: KV get+delete is NOT atomic —
  // a callback arriving in the small window between get and delete can still
  // consume the same state twice. This is a documented, accepted limitation
  // (see docs/cloudflare-write-plan.md, W2 "Known Limitation"); the window is
  // tiny and the worst case is a duplicate token exchange, never a leak.
  await env.TOKENS.delete(stateKey);

  const tokenResponse = await fetch(SPOTIFY_TOKEN, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: env.SPOTIFY_CLIENT_ID,
      code_verifier: statePayload.verifier,
    }),
  });
  const payload = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || !payload?.refresh_token) {
    return html(`<h1>Spotify</h1><p>Token-Austausch fehlgeschlagen (HTTP ${tokenResponse.status}).</p>`, 502);
  }

  await env.TOKENS.put(REFRESH_TOKEN_KEY, payload.refresh_token);
  await env.TOKENS.put(ISSUED_AT_KEY, new Date().toISOString());
  return html('<h1>Spotify verbunden</h1><p>Die Autorisierung war erfolgreich. Dieses Fenster kann geschlossen werden.</p>');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Constant-time comparison so the setup token is not revealed via timing.
function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

export default {
  async fetch(request, env) {
    return logInvocation(request, () => this._fetch(request, env));
  },
  async _fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/setup') return setupPage(request, env);
    if (url.pathname === '/callback' && request.method === 'GET') return callback(request, env);
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    return html('<h1>Not found</h1>', 404);
  },
};
