// Real isolated runtime smoke for spotify-auth OAuthState Durable Object.
// Uses miniflare/workerd locally. ALL Spotify traffic is mocked:
//  - the /setup redirect-follow (Node-side undici global dispatcher) hits a MockAgent,
//  - the in-worker token exchange is mocked via miniflare's fetchMock (MockAgent).
// No real Spotify traffic, no real token exchange, no production KV, no CF account access.
// Run: node --test tests/oauthstate-miniflare.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { createFetchMock } from 'miniflare';

const MOCK_REFRESH_TOKEN = 'mock-refresh-token-local-only';
let authorizeHits = 0;
let exchangeCount = 0;

// Node-side: catches the authorize redirect that dispatchFetch follows.
function mockAuthorizeAgent() {
  authorizeHits = 0;
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get('https://accounts.spotify.com')
    .intercept({ path: /^\/authorize/ })
    .reply(200, () => {
      authorizeHits += 1;
      return 'authorize-mock';
    });
  setGlobalDispatcher(agent);
  return agent;
}

// workerd-side: catches the in-worker token exchange fetch.
function mockTokenAgent() {
  exchangeCount = 0;
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  fetchMock
    .get('https://accounts.spotify.com')
    .intercept({ path: '/api/token', method: 'POST' })
    .reply(200, () => {
      exchangeCount += 1;
      return JSON.stringify({ access_token: 'mock-access', refresh_token: MOCK_REFRESH_TOKEN });
    });
  return fetchMock;
}

async function startMiniflare({ withSetupToken } = {}) {
  mockAuthorizeAgent();
  const bindings = {
    SPOTIFY_CLIENT_ID: 'test-client-id',
    SPOTIFY_CLIENT_SECRET: 'test-client-secret',
  };
  if (withSetupToken) bindings.SETUP_TOKEN = 'local-test-setup-token';
  const mf = new Miniflare({
    scriptPath: 'workers/spotify-auth.js',
    modules: true,
    compatibilityDate: '2025-10-01',
    bindings,
    fetchMock: mockTokenAgent(),
    kvNamespaces: { TOKENS: 'tokenskv' },
    durableObjects: { OAUTH_STATE: 'OAuthState' },
    storage: { durableObjects: { persist: false }, kv: { persist: false } },
  });
  await mf.ready;
  return mf;
}

// Seed a state directly through the real OAuthState class over the DO binding.
async function seedState(mf, state, { expired } = {}) {
  const ns = await mf.getDurableObjectNamespace('OAUTH_STATE');
  const stub = ns.get(ns.idFromName(state));
  const res = await stub.fetch('https://oauth-state.internal/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      verifier: 'local-test-verifier',
      expiresAt: expired ? Date.now() - 1000 : Date.now() + 600_000,
    }),
  });
  assert.equal(res.status, 201, 'OAuthState must accept the seeded state');
}

const BASE = 'https://spotify-auth.nirlau.de';

test('/setup gates access before anything OAuth happens: no token 503, wrong bearer 403', async (t) => {
  const mf = await startMiniflare();
  t.after(() => mf.dispose());

  const unconfigured = await mf.dispatchFetch(`${BASE}/setup`);
  assert.equal(unconfigured.status, 503, 'missing SETUP_TOKEN must fail closed with 503');

  const wrongBearer = await mf.dispatchFetch(`${BASE}/setup`, {
    headers: { authorization: 'Bearer nope' },
  });
  assert.equal(wrongBearer.status, 503, 'unconfigured SETUP_TOKEN fails closed even before bearer check');
  assert.equal(authorizeHits, 0, 'no authorize flow may start');
  assert.equal(exchangeCount, 0);
});

test('/setup with configured token but wrong bearer is denied (403)', async (t) => {
  const mf = await startMiniflare({ withSetupToken: true });
  t.after(() => mf.dispose());
  const wrongBearer = await mf.dispatchFetch(`${BASE}/setup`, {
    headers: { authorization: 'Bearer nope' },
  });
  assert.equal(wrongBearer.status, 403, 'wrong bearer must be denied');
  assert.equal(authorizeHits, 0, 'no authorize flow may start');
  assert.equal(exchangeCount, 0);
});

test('concurrent callbacks for one state produce exactly one token exchange; replay rejected; token stored in KV once', async (t) => {
  const mf = await startMiniflare({ withSetupToken: true });
  t.after(() => mf.dispose());

  await seedState(mf, 'parallel-state');
  const call = () =>
    mf.dispatchFetch(`${BASE}/callback?state=parallel-state&code=auth-code`, {
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
  const results = await Promise.all([call(), call(), call()]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 400, 400], `expected exactly one success among ${statuses}`);
  const winner = await results.find((r) => r.status === 200).text();
  assert.match(winner, /verbunden/i);
  assert.equal(exchangeCount, 1, 'token exchange must run exactly once despite parallel callbacks');

  // Replay with the same state after consumption.
  const replay = await call();
  assert.equal(replay.status, 400, 'replayed state must be rejected');
  assert.equal(exchangeCount, 1);

  const kv = await mf.getKVNamespace('TOKENS');
  assert.equal(await kv.get('spotify:refresh_token'), MOCK_REFRESH_TOKEN);
  assert.ok(await kv.get('spotify:authorized_at'), 'authorized_at must be recorded');
});

test('expired state is treated as consumed: callback 400, no exchange', async (t) => {
  const mf = await startMiniflare({ withSetupToken: true });
  t.after(() => mf.dispose());
  await seedState(mf, 'expired-state', { expired: true });
  const res = await mf.dispatchFetch(`${BASE}/callback?state=expired-state&code=x`);
  assert.equal(res.status, 400, 'expired state must be rejected as invalid');
  assert.equal(exchangeCount, 0);
});

test('seeded state is single-use at the DO level: second PUT gets 409 (atomic create)', async (t) => {
  const mf = await startMiniflare({ withSetupToken: true });
  t.after(() => mf.dispose());
  const ns = await mf.getDurableObjectNamespace('OAUTH_STATE');
  const stub = ns.get(ns.idFromName('atomic-state'));
  const put = () =>
    stub.fetch('https://oauth-state.internal/state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verifier: 'v', expiresAt: Date.now() + 600_000 }),
    });
  const first = await put();
  const second = await put();
  assert.equal(first.status, 201);
  assert.equal(second.status, 409, 'duplicate state must be rejected');
});

test('/setup flow redirects to Spotify authorize carrying state, PKCE and fixed redirect_uri (authorize endpoint mocked, hit exactly once)', async (t) => {
  const mf = await startMiniflare({ withSetupToken: true });
  t.after(() => mf.dispose());
  const res = await mf.dispatchFetch(`${BASE}/setup`, {
    headers: { authorization: 'Bearer local-test-setup-token' },
  });
  // dispatchFetch follows redirects through the mocked global dispatcher, so the
  // mock authorize page is the terminal response — the real Spotify page never loads.
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'authorize-mock');
  assert.equal(authorizeHits, 1, 'exactly one authorize redirect');
  assert.equal(exchangeCount, 0, 'setup alone must not exchange a token');
});
