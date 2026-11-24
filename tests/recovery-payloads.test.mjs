// Tests for the recovery payload set and safe readback projection.
// Run: node --test tests/recovery-payloads.test.mjs
// Fixture scope: this file asserts the recovery payload structure. Its counts are its own;
// they must NOT be mixed with the parent baseline suite totals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayloads } from '../recovery/build-payloads.mjs';
import { projectSettings } from '../recovery/readback-projection.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKERS = ['spotify-auth', 'spotify-proxy', 'riot-proxy', 'steam-proxy'];
const EXPECTED_BINDINGS = {
  'spotify-auth': ['OAUTH_STATE', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'TOKENS'],
  'spotify-proxy': ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN', 'TOKENS'],
  'riot-proxy': ['RIOT_API_KEY'],
  'steam-proxy': ['STEAM_API_KEY'],
};
const EXPECTED_COMPAT = {
  'riot-proxy': '2025-10-01',
  'steam-proxy': '2025-10-03',
  // Live settings show "" which per the documented API behaviour is the effective
  // default 2021-11-02. The payload pins that date explicitly (no reliance on defaults).
  'spotify-auth': '2021-11-02',
  'spotify-proxy': '2021-11-02',
};
const LIVE_PINS = {
  'spotify-auth': 'f9513b3b-1ef4-4a76-ba89-929567392e3c',
  'spotify-proxy': 'e42fb0a3-0cc5-40a3-97a6-60570dfd81d5',
  'riot-proxy': '4b7671ad-c908-4dd6-bfa8-777772c39aca',
  'steam-proxy': '6e8f4f79-f12c-4fd9-97f0-70da34d54b31',
};
const OBSERVABILITY_RIOT_STEAM = {
  enabled: true,
  head_sampling_rate: 1,
  redact_query_string: false,
  logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
  traces: { enabled: false, persist: true, head_sampling_rate: 1 },
};

const generatedDir = join(root, 'recovery', 'generated');
const FILES = ['deploy.json', 'rollback.json'].flatMap((s) => WORKERS.map((w) => `${w}.${s}`));

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

test('deterministic builder: repo artefacts are byte-identical to a fresh tmp output, without overwriting them', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'unfancy-payloads-'));
  buildPayloads({ outDir: tmp });
  assert.deepEqual(readdirSync(tmp).sort(), [...FILES].sort(), 'builder writes exactly the 8 payload files');
  for (const f of FILES) {
    const repoBytes = readFileSync(join(generatedDir, f));
    const tmpBytes = readFileSync(join(tmp, f));
    assert.ok(repoBytes.equals(tmpBytes), `${f}: repo artefact must be byte-for-byte identical to the builder output (drift must FAIL, never be overwritten silently)`);
  }
});

test('determinism NEGATIVE test: a mutated generated file is detected as drift', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'unfancy-payloads-'));
  buildPayloads({ outDir: tmp });
  // Mutate one byte in one generated file inside a throwaway copy (repo untouched).
  const victim = 'riot-proxy.deploy.json';
  const bytes = readFileSync(join(tmp, victim));
  bytes[0] = bytes[0] === 0x7b ? 0x7c : 0x7b; // flip '{' <-> '|'
  writeFileSync(join(tmp, victim), bytes);
  let driftDetected = false;
  for (const f of FILES) {
    if (!readFileSync(join(tmp, f)).equals(readFileSync(join(generatedDir, f)))) driftDetected = true;
  }
  assert.equal(driftDetected, true, `a byte mutation in ${victim} must be detected — the comparison must fail on drift, never normalize it`);
});

test('committed byte pins: recovery/generated/SHA256SUMS.txt matches the actual repo files', () => {
  const sums = readFileSync(join(generatedDir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 8);
  for (const line of sums) {
    const [hash, file] = line.split(/\s{2}/);
    const actual = createHash('sha256').update(readFileSync(join(generatedDir, file))).digest('hex');
    assert.equal(actual, hash, `${file} must match its committed SHA-256 byte pin`);
  }
});

test('deploy payloads: strict inherit, name-only bindings, migrations OBJECT (not array), full safe-settings preservation', () => {
  for (const worker of WORKERS) {
    const p = JSON.parse(readFileSync(join(generatedDir, `${worker}.deploy.json`), 'utf8'));
    assert.equal(p.query.bindings_inherit, 'strict', `${worker}: strict inherit must prevent silent binding drops`);
    assert.equal(p.method, 'PUT');
    assert.equal(p.apply_approval === 'EXECUTABLE' || ['spotify-auth', 'spotify-proxy'].includes(worker), true);

    const json = JSON.stringify(p);
    assert.doesNotMatch(json, /"(text|value)"\s*:\s*"/, `${worker}: payload must not carry any binding value`);

    const bindings = p.metadata.bindings;
    assert.deepEqual(bindings.map((b) => b.name).sort(), EXPECTED_BINDINGS[worker].sort());
    for (const b of bindings) {
      if (b.type === 'inherit') assert.deepEqual(Object.keys(b).sort(), ['name', 'type'], `${worker}: strict inherit is name-only incl. exact key set`);
      if (b.type === 'durable_object_namespace') {
        assert.equal(b.class_name, 'OAuthState');
        assert.deepEqual(Object.keys(b).sort(), ['class_name', 'name', 'type']);
      }
    }

    if (worker === 'spotify-auth') {
      // Official cloudflare/api-schemas: migrations is an OBJECT (tag conditions + steps),
      // NOT an array.
      assert.equal(typeof p.metadata.migrations, 'object');
      assert.ok(!Array.isArray(p.metadata.migrations), 'migrations must be an object, not an array');
      assert.deepEqual(p.metadata.migrations, {
        new_tag: 'unfancy-oauthstate-2026-11-24',
        steps: [{ new_sqlite_classes: ['OAuthState'] }],
      });
      assert.equal(p.live_migration_tag_before.state, 'absent', 'earlier migration tag is explicitly pinned absent — no assumptions');
    } else {
      assert.equal(p.metadata.migrations, undefined, `${worker}: no migration`);
    }

    assert.equal(p.metadata.compatibility_date, EXPECTED_COMPAT[worker], `${worker}: compat date pinned explicitly`);

    // Full safe settings preserved (riot/steam: observability exact; spotify: observability absent).
    if (worker === 'riot-proxy' || worker === 'steam-proxy') {
      assert.deepEqual(p.metadata.observability, OBSERVABILITY_RIOT_STEAM, `${worker}: full observability object preserved exactly`);
      assert.deepEqual(p.preapply_guards.full_settings.pinned_full_settings.observability, OBSERVABILITY_RIOT_STEAM);
      assert.deepEqual(p.metadata.compatibility_flags, []);
      assert.deepEqual(p.metadata.tags, []);
      assert.equal(p.metadata.logpush, false);
      assert.deepEqual(p.metadata.tail_consumers, []);
      assert.deepEqual(p.metadata.placement, {});
      assert.equal(p.metadata.usage_model, 'standard');
      for (const [k, v] of Object.entries(p.preapply_guards.full_settings.pinned_classifications)) {
        assert.ok(['preserve', 'absent', 'n.a.'].includes(v), `${worker}: classification for ${k} must be explicit (got ${v})`);
      }
      assert.equal(p.preapply_guards.full_settings.skipped, false, `${worker}: settings guard is enabled (secret_text-only bindings)`);
    } else {
      assert.equal(p.metadata.observability, undefined, `${worker}: observability absent in live settings -> omitted, never defaulted`);
      assert.equal(p.preapply_guards.full_settings.skipped, worker === 'spotify-proxy');
    }

    // Byte pins present.
    assert.match(p.metadata_sha256 ?? '', /^[0-9a-f]{64}$/, `${worker}: metadata must be SHA-256 pinned`);
    for (const part of p.parts) {
      assert.match(p.part_sha256[part.filename] ?? '', /^[0-9a-f]{64}$/, `${worker}: part ${part.filename} must be SHA-256 pinned`);
    }
  }
});

test('scope: steam+riot executable, spotify-proxy gated read scope, spotify-auth NOT YET APPROVED (DO lifecycle rollback blocker)', () => {
  const approval = {};
  for (const worker of WORKERS) {
    const d = JSON.parse(readFileSync(join(generatedDir, `${worker}.deploy.json`), 'utf8'));
    approval[worker] = d.apply_approval;
  }
  assert.equal(approval['steam-proxy'], 'EXECUTABLE');
  assert.equal(approval['riot-proxy'], 'EXECUTABLE');
  assert.equal(approval['spotify-proxy'], 'GATED_READ_SCOPE');
  assert.equal(approval['spotify-auth'], 'NOT_YET_APPROVED');
  assert.match(approval['spotify-auth'], /NOT_YET_APPROVED/);
  const authDeploy = JSON.parse(readFileSync(join(generatedDir, 'spotify-auth.deploy.json'), 'utf8'));
  assert.match(authDeploy.apply_blocker, /DO class lifecycle/);
  assert.match(authDeploy.apply_blocker, /NO supported-rollback claim/i);
});

test('preapply guards: active deployment AND latest upload pins; inherit resolves to LATEST UPLOAD not active', () => {
  for (const worker of WORKERS) {
    const d = JSON.parse(readFileSync(join(generatedDir, `${worker}.deploy.json`), 'utf8'));
    const g = d.preapply_guards;
    assert.match(g.active_deployment.assert, /pinned_live_deployment_id/);
    assert.match(g.active_deployment.assert, /pinned_live_version_id/);
    assert.match(g.latest_upload.assert, /latest version id .*===.*pinned_live_version_id|newest version id in the versions list === pinned_live_version_id/i);
    assert.match(g.latest_upload.assert, /extra\/unpublished version -> STOP/i);
  }
});

test('spotify-proxy: settings GET and GET versions/{id} are forbidden reads everywhere in the payloads', () => {
  for (const suffix of ['deploy.json', 'rollback.json']) {
    const p = JSON.parse(readFileSync(join(generatedDir, `spotify-proxy.${suffix}`), 'utf8'));
    const text = JSON.stringify(p);
    // No endpoint in either payload may point at /settings for spotify-proxy.
    for (const section of suffix === 'deploy.json'
      ? [p.preapply_guards.active_deployment, p.preapply_guards.latest_upload, p.preapply_guards.full_settings, p.post_deploy_readback]
      : [p.pre_rollback_assert]) {
      assert.doesNotMatch(section?.endpoint ?? '', /\/settings$/, 'no settings GET for spotify-proxy');
    }
    if (suffix === 'rollback.json') assert.ok(p.rollback_supported, 'spotify-proxy rollback stays executable');
    assert.match(text, /forbidden/i, 'the forbidden-read scope must be explicit');
  }
  // The deploy payload's full_settings guard is skipped with the frozen snapshot inventory.
  const d = JSON.parse(readFileSync(join(generatedDir, 'spotify-proxy.deploy.json'), 'utf8'));
  assert.equal(d.preapply_guards.full_settings.skipped, true);
  assert.deepEqual(d.preapply_guards.full_settings.frozen_bindings_inventory, [
    { name: 'SPOTIFY_CLIENT_ID', type: 'plain_text' },
    { name: 'SPOTIFY_CLIENT_SECRET', type: 'secret_text' },
    { name: 'SPOTIFY_REFRESH_TOKEN', type: 'plain_text' },
    { name: 'TOKENS', type: 'kv_namespace' },
  ].sort((a, b) => a.name.localeCompare(b.name)));
  assert.match(d.preapply_guards.full_settings.binding_drift_safety_note, /NOT verifiable/i);
});

test('rollback payloads: own-version pre-rollback guard, foreign abort, failed-PUT no-rollback semantics', () => {
  for (const worker of WORKERS) {
    const p = JSON.parse(readFileSync(join(generatedDir, `${worker}.rollback.json`), 'utf8'));
    assert.equal(p.method, 'POST');
    assert.match(p.endpoint, /\/deployments$/);
    assert.deepEqual(p.body.versions, [{ version_id: LIVE_PINS[worker], percentage: 100 }]);
    assert.match(p.pre_rollback_assert.assert, /NEWLY CREATED own version id/, 'guard must target the runtime own version, not a hard-coded pin');
    assert.match(p.pre_rollback_assert.assert, /Foreign version active -> STOP/);
    assert.match(p.pre_rollback_assert.assert, /Old pin still active -> SKIP rollback/);
    assert.match(p.failure_semantics, /no repeat|no blind retry/i);
    if (worker === 'spotify-auth') {
      assert.equal(p.rollback_supported, false, 'auth rollback is NOT supported by version deployment (DO class lifecycle)');
      assert.match(p.rollback_note, /DO class lifecycle|SQLite migration state/i);
    } else {
      assert.equal(p.rollback_supported, true);
    }
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
