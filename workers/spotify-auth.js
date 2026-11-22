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
  // Fail closed: do not expose an OAuth flow that can replace the stored token.
  // Keep the credential out of URLs, where it would leak into logs and history.
  if (!env.SETUP_TOKEN) return html('<h1>Spotify</h1><p>Setup nicht konfiguriert.</p>', 503);
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!timingSafeEqual(provided, env.SETUP_TOKEN)) {
    return html('<h1>Spotify</h1><p>Setup-Zugang verweigert.</p>', 403);
  }

  const verifier = randomVerifier();
  const challenge = await codeChallenge(verifier);
  const state = randomState();
  if (!env.OAUTH_STATE) throw new Error('OAUTH_STATE Durable Object binding is required');
  const stateObject = env.OAUTH_STATE.get(env.OAUTH_STATE.idFromName(state));
  const stored = await stateObject.fetch('https://oauth-state.internal/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verifier, expiresAt: Date.now() + STATE_TTL_SECONDS * 1000 }),
  });
  if (!stored.ok) throw new Error('Could not store OAuth state');

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

  if (!env.OAUTH_STATE) throw new Error('OAUTH_STATE Durable Object binding is required');
  const stateObject = env.OAUTH_STATE.get(env.OAUTH_STATE.idFromName(state));
  const consumed = await stateObject.fetch('https://oauth-state.internal/state', { method: 'DELETE' });
  if (consumed.status === 404) return html('<h1>Spotify</h1><p>OAuth-Zustand ungültig, abgelaufen oder bereits verwendet.</p>', 400);
  if (!consumed.ok) return html('<h1>Spotify</h1><p>OAuth-Zustand konnte nicht geprüft werden.</p>', 503);
  const statePayload = await consumed.json();

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

export class OAuthState {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/state') return new Response('Not found', { status: 404 });

    if (request.method === 'PUT') {
      const payload = await request.json();
      if (typeof payload?.verifier !== 'string' || !payload.verifier || !Number.isFinite(payload.expiresAt)) {
        return new Response('Invalid state payload', { status: 400 });
      }
      const stored = await this.storage.transaction(async (txn) => {
        if (await txn.get('state')) return false;
        await txn.put('state', payload);
        return true;
      });
      return new Response(null, { status: stored ? 201 : 409 });
    }

    if (request.method === 'DELETE') {
      const payload = await this.storage.transaction(async (txn) => {
        const value = await txn.get('state');
        if (!value) return null;
        await txn.delete('state');
        return value;
      });
      if (!payload || payload.expiresAt <= Date.now()) return new Response(null, { status: 404 });
      return Response.json({ verifier: payload.verifier }, { headers: { 'cache-control': 'no-store' } });
    }

    return new Response('Method not allowed', { status: 405 });
  }
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
