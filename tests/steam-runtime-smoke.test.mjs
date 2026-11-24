import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, createFetchMock } from 'miniflare';
import { cliSmoke } from '../recovery/staged-runner.mjs';

test('Steam deployed module contract passes real workerd positive/CORS/negative smoke', async (t) => {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  fetchMock.get('https://api.steampowered.com').intercept({
    path: '/ISteamUser/GetPlayerSummaries/v2/?key=local-runtime-test-key&steamids=76561198159661156',
  }).reply(200, JSON.stringify({ response: { players: [{ steamid: '76561198159661156' }] } })).persist();
  const mf = new Miniflare({
    modules: [
      { type: 'ESModule', path: 'workers/steam-proxy.js' },
      { type: 'ESModule', path: 'workers/invocation-logging.js' },
    ],
    compatibilityDate: '2025-10-03',
    bindings: { STEAM_API_KEY: 'local-runtime-test-key' }, fetchMock,
  });
  t.after(() => mf.dispose());
  await mf.ready;
  await cliSmoke('steam-proxy', 'after-activation', (url, options) => mf.dispatchFetch(url, options));
  const negative = await mf.dispatchFetch('https://steam.api.nirlau.de/currently-playing?steamid=abc', {
    headers: { Origin: 'https://nirlau.de' },
  });
  assert.equal(negative.status, 400);
  assert.equal(negative.headers.get('cache-control'), 'no-store');
});
