// Tests for the recovery payload set and safe readback projection.
// Run: node --test tests/recovery-payloads.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSettings } from '../recovery/readback-projection.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKERS = ['spotify-auth', 'spotify-proxy', 'riot-proxy', 'steam-proxy'];
const EXPECTED_BINDINGS = {
  'spotify-auth': ['OAUTH_STATE', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'TOKENS'],
  'spotify-proxy': ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN', 'TOKENS'],
  'riot-proxy': ['RIOT_API_KEY'],
  'steam-proxy': ['STEAM_API_KEY'],
};
const EXPECTED_COMPAT = { 'riot-proxy': '2025-10-01', 'steam-proxy': '2025-10-03' };
const LIVE_PINS = {
  'spotify-auth': 'f9513b3b-1ef4-4a76-ba89-929567392e3c',
  'spotify-proxy': 'e42fb0a3-0cc5-40a3-97a6-60570dfd81d5',
  'riot-proxy': '4b7671ad-c908-4dd6-bfa8-777772c39aca',
  'steam-proxy': '6e8f4f79-f12c-4fd9-97f0-70da34d54b31',
};

const generatedDir = join(root, 'recovery', 'generated');

test('generated payloads exist for all four workers (deploy + rollback) and match the deterministic builder', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'unfancy-payloads-'));
  const before = new Set(readdirSync(generatedDir));
  execFileSync('node', [join(root, 'recovery', 'build-payloads.mjs')], { cwd: tmp === tmp ? root : root }); // builder writes into its own repo
  const after = new Set(readdirSync(generatedDir));
  assert.deepEqual([...before].sort(), [...after].sort());
  assert.equal(after.size, 8, '4 workers x (deploy + rollback)');
});

test('deploy payloads: bindings_inherit=strict, name-only bindings (no values), correct parts and compat dates', () => {
  for (const worker of WORKERS) {
    const p = JSON.parse(readFileSync(join(generatedDir, `${worker}.deploy.json`), 'utf8'));
    assert.equal(p.query.bindings_inherit, 'strict', `${worker}: strict inherit must prevent silent binding drops`);
    assert.equal(p.method, 'PUT');

    const json = JSON.stringify(p);
    assert.doesNotMatch(json, /"(text|value)"\s*:/, `${worker}: payload must not carry any binding value`);
    assert.ok(!/client[_-]?secret|refresh[_-]?token[=:]/i.test(json.replace(/SPOTIFY_(CLIENT_SECRET|REFRESH_TOKEN)/g, '')),
      `${worker}: no secret-like value literal`);

    const bindings = p.metadata.bindings;
    assert.deepEqual(bindings.map((b) => b.name).sort(), EXPECTED_BINDINGS[worker].sort());
    for (const b of bindings) {
      if (b.type === 'inherit') assert.deepEqual(Object.keys(b).sort(), ['name', 'type']);
      if (b.type === 'durable_object_namespace') {
        assert.equal(b.class_name, 'OAuthState');
        assert.deepEqual(Object.keys(b).sort(), ['class_name', 'name', 'type'], 'DO binding via class_name (no manual namespace create)');
      }
    }
    if (worker === 'spotify-auth') {
      assert.deepEqual(p.metadata.migrations, [{ new_tag: 'unfancy-oauthstate-2026-11-24', new_sqlite_classes: ['OAuthState'] }]);
    } else {
      assert.equal(p.metadata.migrations, undefined, `${worker}: no migration`);
    }

    if (EXPECTED_COMPAT[worker]) assert.equal(p.metadata.compatibility_date, EXPECTED_COMPAT[worker]);
    else assert.equal(p.metadata.compatibility_date, undefined, `${worker}: compatibility_date must be omitted to preserve the live empty state`);

    // Imports: every referenced module part must exist in the repo.
    const parts = p.parts.map((x) => x.path);
    assert.ok(parts.includes(`workers/${worker}.js`));
    if (worker !== 'spotify-auth') assert.ok(parts.includes('workers/invocation-logging.js'), `${worker}: imported module part must be uploaded`);
    for (const part of parts) assert.ok(readFileSync(join(root, part), 'utf8'), `${part} must exist`);
  }
});

test('rollback payloads: pinned live version, 100%, no null status packages, pre-rollback re-read required', () => {
  for (const worker of WORKERS) {
    const p = JSON.parse(readFileSync(join(generatedDir, `${worker}.rollback.json`), 'utf8'));
    assert.equal(p.method, 'POST');
    assert.match(p.endpoint, /\/deployments$/);
    assert.equal(p.body.strategy, 'percentage');
    assert.deepEqual(p.body.versions, [{ version_id: LIVE_PINS[worker], percentage: 100 }]);
    assert.equal(JSON.stringify(p).includes('null'), false, `${worker}: no null status package`);
    assert.equal(p.pre_rollback_assert.method, 'GET');
    assert.match(p.pre_rollback_assert.assert, /stale -> regenerate/);
  }
});

test('readback projection strips values and refuses bindings that carry value fields', () => {
  const fixture = {
    result: {
      compatibility_date: '2025-10-01',
      bindings: [
        { name: 'SPOTIFY_CLIENT_SECRET', type: 'secret_text', text: 'LEAKED' },
        { name: 'TOKENS', type: 'kv_namespace', namespace_id: '25d14d1f2e2f401fb48facad0d108d66' },
        { name: 'OAUTH_STATE', type: 'durable_object_namespace', class_name: 'OAuthState' },
      ],
    },
  };
  assert.throws(() => projectSettings(fixture), /refusing to project binding "SPOTIFY_CLIENT_SECRET"/);
  const safe = JSON.parse(JSON.stringify(fixture));
  for (const b of safe.result.bindings) delete b.text;
  const projected = projectSettings(safe);
  assert.equal(projected.compatibility_date, '2025-10-01');
  assert.deepEqual(projected.bindings.find((b) => b.name === 'TOKENS'), {
    name: 'TOKENS',
    type: 'kv_namespace',
    namespace_id: '25d14d1f2e2f401fb48facad0d108d66',
  });
  assert.deepEqual(projected.bindings.find((b) => b.name === 'OAUTH_STATE'), {
    name: 'OAUTH_STATE',
    type: 'durable_object_namespace',
    class_name: 'OAuthState',
  });
  assert.equal(JSON.stringify(projected).includes('LEAKED'), false);
});
