const SPOTIFY_AUTHORIZE = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN = 'https://accounts.spotify.com/api/token';
const SCOPES = 'user-read-currently-playing user-top-read';
const STATE_TTL_SECONDS = 600;
const REFRESH_TOKEN_KEY = 'spotify:refresh_token';
const ISSUED_AT_KEY = 'spotify:authorized_at';

// The OAuth host is pinned; redirect URIs and accepted origins must never be
// derived from attacker-controlled request data.
const ALLOWED_ORIGINS = ['https://spotify-auth.nirlau.de'];

function html(body, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Spotify-Verbindung</title><main style="font-family:system-ui;max-width:42rem;margin:4rem auto;padding:1rem;background:#111;color:#eee">${body}</main>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function redirectUri() {
  return `${ALLOWED_ORIGINS[0]}/callback`;
}

function originAllowed(request) {
  const origin = new URL(request.url).origin;
  return ALLOWED_ORIGINS.includes(origin);
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
  // Exactly-once consume: replaying the same state must fail.
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/setup') return setupPage(request, env);
    if (url.pathname === '/callback' && request.method === 'GET') return callback(request, env);
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    return html('<h1>Not found</h1>', 404);
  },
};
