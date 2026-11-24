// Failure-injection state-transition tests for the real apply/rollback orchestrator
// (recovery/runner.mjs). Run: node --test tests/runner-orchestrator.test.mjs
// Every test drives the REAL createRunner flow with an injected transport — no helper
// mocks of inner apply steps. Transport calls are recorded and asserted. No network.
//
// Fixture scope: counts in this file belong to this file; they must NOT be mixed with
// the parent baseline suite totals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner, RunnerAbort } from '../recovery/runner.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = (w) => join(root, 'recovery', 'generated', `${w}.deploy.json`);
const ROLLBACK = (w) => join(root, 'recovery', 'generated', `${w}.rollback.json`);

const ACCOUNT = 'test-account-id';
const OLD_PIN = {
  'steam-proxy': { dep: '669fc653-539d-4f5f-83ef-3bd2de8c1f28', ver: '6e8f4f79-f12c-4fd9-97f0-70da34d54b31' },
  'riot-proxy': { dep: '7b0c6e80-8469-48a8-a459-275fb43a7c63', ver: '4b7671ad-c908-4dd6-bfa8-777772c39aca' },
};
const NEW_VERSION = '11111111-2222-3333-4444-555555555555';

function deploymentsBody({ deploymentId, versionId }) {
  return {
    success: true,
    result: { deployments: [{ id: deploymentId, versions: [{ version_id: versionId, percentage: 100 }] }] },
  };
}

function versionsListBody({ newestId, total = 6 }) {
  return {
    success: true,
    result: [{ id: newestId, created_on: '2026-11-24T00:00:00Z' }],
    result_info: { total_count: total },
  };
}

// Live settings shape for riot/steam from the redacted discovery snapshot (secret-only bindings).
function settingsBody({ compatibilityDate, worker }) {
  return {
    success: true,
    result: {
      placement: {},
      compatibility_date: compatibilityDate,
      compatibility_flags: [],
      usage_model: 'standard',
      tags: [],
      tail_consumers: [],
      logpush: false,
      observability: {
        enabled: true,
        head_sampling_rate: 1,
        redact_query_string: false,
        logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
        traces: { enabled: false, persist: true, head_sampling_rate: 1 },
      },
      annotations: { 'workers/triggered_by': 'upload' }, // n.a. field, never sent
      bindings: worker === 'riot-proxy'
        ? [{ name: 'RIOT_API_KEY', type: 'secret_text' }]
        : [{ name: 'STEAM_API_KEY', type: 'secret_text' }],
    },
  };
}

// Fake transport: url-shape router over a mutable world state + call log.
function makeTransport({ world, onPut, onPostDeployment }) {
  const calls = [];
  return { calls, transport: makeTransportImpl() };
  function makeTransportImpl() {
    return async ({ method, url, headers, body }) => {
      calls.push({ method, url, headers: { ...headers }, body });
      const u = new URL(url);
      const script = u.pathname.match(/workers\/scripts\/([^/]+)/)?.[1];
      const compatDate = world.compatDate;
      if (method === 'GET' && url.includes('/deployments?')) return { status: 200, json: deploymentsBody(world.active) };
      if (method === 'GET' && url.includes('/versions') && !url.match(/\/versions\/[0-9a-f-]{36}$/)) {
        return { status: 200, json: versionsListBody({ newestId: world.newestUploadId, total: world.versionCount }) };
      }
      if (method === 'GET' && url.match(/\/versions\/[0-9a-f-]{36}$/)) return { status: 200, json: { success: true, result: { id: world.oldVersionId } } };
      if (method === 'GET' && url.endsWith('/settings')) return { status: 200, json: world.settings ?? settingsBody({ compatibilityDate: compatDate, worker: script }) };
      if (method === 'PUT') {
        if (onPut) return onPut({ url, headers, body });
        world.active = { deploymentId: 'newdep-1', versionId: NEW_VERSION };
        return { status: 200, json: { success: true, result: { id: NEW_VERSION } } };
      }
      if (method === 'POST' && url.includes('/deployments')) {
        if (onPostDeployment) return onPostDeployment({ url, headers, body });
        world.active = { deploymentId: OLD_PIN[script]?.dep ?? world.oldDeploymentId, versionId: world.oldVersionId };
        return { status: 200, json: { success: true, result: {} } };
      }
      return { status: 404, json: null };
    };
  }
}

function makeRunner(worker, world, opts = {}) {
  const payload = JSON.parse(readFileSync(GENERATED(worker), 'utf8'));
  const rollbackPayload = JSON.parse(readFileSync(ROLLBACK(worker), 'utf8'));
  const { calls, transport } = makeTransport({ world, ...opts });
  const logs = [];
  const runner = createRunner({
    worker, account: ACCOUNT, payload, rollbackPayload,
    transport, log: (m) => logs.push(m),
    readFile: opts.readFile ?? ((p) => readFileSync(p)),
    repoRoot: root,
  });
  return { runner, calls, logs, payload, rollbackPayload };
}

function baseWorld(worker) {
  const pin = OLD_PIN[worker];
  return {
    active: { deploymentId: pin.dep, versionId: pin.ver },
    newestUploadId: pin.ver,
    versionCount: 6,
    oldVersionId: pin.ver,
    oldDeploymentId: pin.dep,
    compatDate: worker === 'riot-proxy' ? '2025-10-01' : '2025-10-03',
  };
}

// ---------------------------------------------------------------------------

test('success path: preapply guards pass, apply verified via deployments readback, no rollback', async () => {
  const world = baseWorld('steam-proxy');
  const { runner, calls, payload } = makeRunner('steam-proxy', world);
  const out = await runner.runApply();
  assert.equal(out.verified, true);
  assert.equal(out.versionId, NEW_VERSION);
  const methods = calls.map((c) => c.method);
  assert.deepEqual(methods, ['GET', 'GET', 'GET', 'PUT', 'GET', 'GET'], 'exact call sequence: deployments, versions, settings guards, PUT, deployments readback, settings readback');
  // PUT must carry strict-inherit query and the sha256-pinned metadata.
  const put = calls.find((c) => c.method === 'PUT');
  assert.match(put.url, /\?bindings_inherit=strict$/);
  assert.match(put.headers['Content-Type'], /multipart\/form-data; boundary=unfancy-/);
  const bodyStr = put.body.toString();
  assert.ok(bodyStr.includes('"main_module"'), 'metadata part is the pinned JSON');
  assert.ok(bodyStr.includes('STEAM_API_KEY'), 'binding names appear as inherit references (names only, no values)');
  assert.ok(!/STEAM_API_KEY[=:]/.test(bodyStr.replace('"STEAM_API_KEY"', '')), 'no value assignment for the secret name');
  const metadataEnd = bodyStr.indexOf('\r\n--', bodyStr.indexOf('{'));
  const metadataFromTest = JSON.parse(bodyStr.slice(bodyStr.indexOf('{'), metadataEnd));
  assert.deepEqual(metadataFromTest, payload.metadata);
});

test('success path details: PUT metadata is exactly the pinned metadata, name-only inherit bindings', async () => {
  const world = baseWorld('riot-proxy');
  const { runner, calls, payload } = makeRunner('riot-proxy', world);
  await runner.runApply();
  const put = calls.find((c) => c.method === 'PUT');
  const body = put.body.toString();
  const metadataEnd = body.indexOf('\r\n--', body.indexOf('{'));
  const metadata = JSON.parse(body.slice(body.indexOf('{'), metadataEnd));
  assert.deepEqual(metadata, payload.metadata, 'runner must send the pinned metadata byte-exact (no runtime mutation)');
  for (const b of metadata.bindings) {
    if (b.type === 'inherit') assert.deepEqual(Object.keys(b).sort(), ['name', 'type']);
  }
});

test('failure injection: prewrite bindings inventory drift -> no PUT is issued', async () => {
  const world = baseWorld('steam-proxy');
  world.settings = settingsBody({ compatibilityDate: '2025-10-03', worker: 'steam-proxy' });
  world.settings.result.bindings.push({ name: 'EXTRA_BINDING', type: 'secret_text' });
  const { runner, calls } = makeRunner('steam-proxy', world);
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'bindings_inventory_drift');
  assert.equal(calls.some((c) => c.method === 'PUT'), false, 'no PUT after prewrite drift');
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET', 'GET']);
});

test('failure injection: prewrite safe-settings drift (observability changed) -> no PUT', async () => {
  const world = baseWorld('riot-proxy');
  world.settings = settingsBody({ compatibilityDate: '2025-10-01', worker: 'riot-proxy' });
  world.settings.result.observability.redact_query_string = true; // drifted from pinned false
  const { runner, calls } = makeRunner('riot-proxy', world);
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'safe_settings_drift');
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});

test('failure injection: unknown live settings field -> abort, no PUT (no default handling)', async () => {
  const world = baseWorld('riot-proxy');
  world.settings = settingsBody({ compatibilityDate: '2025-10-01', worker: 'riot-proxy' });
  world.settings.result.some_brand_new_field = { unknown: true };
  const { runner, calls } = makeRunner('riot-proxy', world);
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'unknown_settings_field');
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});

test('failure injection: extra unpublished version (newest upload != active pin) -> abort before PUT', async () => {
  const world = baseWorld('riot-proxy');
  world.newestUploadId = 'aaaa1111-2222-3333-4444-555555555555';
  const { runner, calls } = makeRunner('riot-proxy', world);
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'preapply_latest_upload_extra');
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});

test('failure injection: active deployment drifted (stale pin) -> abort before PUT, no repeat', async () => {
  const world = baseWorld('riot-proxy');
  world.active = { deploymentId: 'other-dep', versionId: 'other-ver' };
  const { runner, calls } = makeRunner('riot-proxy', world);
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'preapply_active_deployment_drift');
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1, 'stops at first guard, no reads beyond');
});

test('failure injection: byte drift in a worker part -> abort BEFORE the PUT, nothing sent', async () => {
  const world = baseWorld('steam-proxy');
  const tmp = mkdtempSync(join(tmpdir(), 'runner-bytes-'));
  writeFileSync(join(tmp, 'steam-proxy.js'), readFileSync(join(root, 'workers', 'steam-proxy.js')) + '\n// drifted\n');
  const { runner, calls } = makeRunner('steam-proxy', world, {
    readFile: (p) => (p.endsWith('steam-proxy.js') ? readFileSync(join(tmp, 'steam-proxy.js')) : readFileSync(p)),
  });
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'part_byte_drift');
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});

test('failure injection: API-rejected PUT with unchanged state -> no rollback is attempted', async () => {
  const world = baseWorld('steam-proxy');
  const { runner, calls } = makeRunner('steam-proxy', world, {
    onPut: () => ({ status: 400, json: { success: false, errors: [{ code: 10057 }] } }),
  });
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'put_failed_unchanged');
  assert.equal(calls.some((c) => c.method === 'POST'), false, 'a failed/unchanged PUT must NOT trigger a rollback');
});

test('failure injection: network error on PUT with old pin still active -> classified once, no repeat', async () => {
  const world = baseWorld('steam-proxy');
  let readbackCount = 0;
  const { runner, calls } = makeRunner('steam-proxy', world, {
    onPut: async () => { throw new Error('ECONNRESET'); },
  });
  // readActiveDeployment is used by the runner only once for classification; count via wrapper below.
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'put_failed_unchanged');
  readbackCount = calls.filter((c) => c.method === 'GET' && c.url.includes('/deployments?')).length;
  assert.equal(readbackCount, 2, 'exactly ONE classifications readback after the unknown PUT outcome (the other deployments GET is the preapply guard)');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1, 'no PUT repeat');
  assert.equal(calls.some((c) => c.method === 'POST'), false, 'no rollback after unchanged classification');
});

test('failure injection: POST succeeds but activation did not stick (old pin still active) -> unverified, no repeat, no rollback', async () => {
  const world = baseWorld('steam-proxy');
  const { runner, calls } = makeRunner('steam-proxy', world, {
    onPut: () => {
      // Accept but do NOT change world.active: response claims success, state stays old pin.
      return { status: 200, json: { success: true, result: { id: NEW_VERSION } } };
    },
  });
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'postapply_old_pin_still_active');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1, 'no repeat');
  assert.equal(calls.some((c) => c.method === 'POST'), false, 'no blind rollback against the old pin');
});

test('failure injection: foreign deployment active after PUT -> STOP, never auto-rollback over it', async () => {
  const world = baseWorld('riot-proxy');
  const { runner, calls } = makeRunner('riot-proxy', world, {
    onPut: () => {
      world.active = { deploymentId: 'foreign-dep', versionId: 'foreign-version-id' };
      return { status: 200, json: { success: true, result: { id: NEW_VERSION } } };
    },
  });
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'postapply_foreign_deployment');
  assert.equal(calls.some((c) => c.method === 'POST'), false, 'no rollback attempted while a foreign version is active');
});

test('failure injection: foreign version becomes active between apply and rollback -> rollback aborts (STOP)', async () => {
  const world = baseWorld('steam-proxy');
  world.settings = settingsBody({ compatibilityDate: '2025-10-03', worker: 'steam-proxy' });
  const { runner, calls } = makeRunner('steam-proxy', world);
  await runner.preapply(); // passes against clean state
  await runner.apply();
  // Drift appears between apply and verification.
  world.settings.result.compatibility_date = '9999-01-01';
  await assert.rejects(() => runner.postApplyVerify(), (e) => e.reason === 'postapply_compat_date_drift');
  world.active = { deploymentId: 'foreign-dep', versionId: 'foreign-version' };
  await assert.rejects(() => runner.rollback(), (e) => e instanceof RunnerAbort && e.reason === 'rollback_foreign_deployment');
  assert.equal(calls.some((c) => c.method === 'POST'), false, 'rollback aborted: no POST while foreign version active');
});

test('full success+rollback cycle: apply verified, settings drift detected, rollback to own-version guard, back to old pin', async () => {
  const world = baseWorld('riot-proxy');
  world.settings = settingsBody({ compatibilityDate: '2025-10-01', worker: 'riot-proxy' });
  const { runner, calls } = makeRunner('riot-proxy', world);
  await runner.preapply();
  await runner.apply();
  // Drift appears between apply and verification.
  world.settings.result.compatibility_flags = ['x']; // unknown drift in a preserved field
  await assert.rejects(() => runner.postApplyVerify(), (e) => e.reason === 'safe_settings_drift');
  const rb = await runner.rollback(); // guard sees own new version -> proceeds
  assert.equal(rb.skipped, false);
  assert.equal(rb.verified, true);
  assert.equal(world.active.versionId, OLD_PIN['riot-proxy'].ver, 'active deployment is back on the pinned live version');
  const post = calls.find((c) => c.method === 'POST');
  assert.match(post.url, /\/deployments$/);
  assert.equal(JSON.parse(post.body.toString()).versions[0].version_id, OLD_PIN['riot-proxy'].ver);
});

test('rollback guard skips when the old pin is active again (PUT never took effect / already reverted)', async () => {
  const world = baseWorld('steam-proxy');
  const { runner, calls } = makeRunner('steam-proxy', world);
  // Simulate state where own version was recorded but the active readback shows old pin.
  await runner.preapply();
  await runner.apply();
  world.active = { deploymentId: OLD_PIN['steam-proxy'].dep, versionId: OLD_PIN['steam-proxy'].ver };
  const rb = await runner.rollback();
  assert.equal(rb.skipped, true, 'rollback skipped — nothing to roll back');
  assert.equal(rb.reason, 'old_pin_still_active');
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});

test('runner refuses the gated spotify-proxy scope: no runner instance, so no forbidden reads are even possible', async () => {
  const payload = JSON.parse(readFileSync(GENERATED('spotify-proxy'), 'utf8'));
  const rollbackPayload = JSON.parse(readFileSync(ROLLBACK('spotify-proxy'), 'utf8'));
  const { transport } = makeTransport({ world: baseWorld('riot-proxy') });
  assert.equal(payload.apply_approval, 'GATED_READ_SCOPE');
  assert.throws(() => createRunner({
    worker: 'spotify-proxy', account: ACCOUNT, payload, rollbackPayload,
    transport, log: () => {}, readFile: (p) => readFileSync(p), repoRoot: root,
  }), (e) => e instanceof RunnerAbort && e.reason === 'apply_not_approved');
  // And the payload itself carries no settings GET endpoint anywhere in its guards.
  const text = JSON.stringify(payload);
  assert.ok(!text.includes('workers/scripts/spotify-proxy/settings'), 'spotify-proxy payload must not reference the forbidden settings endpoint');
  assert.ok(!/versions\/[0-9a-f-]{36}/.test(text), 'spotify-proxy payload must not reference GET versions/{id}');
});

test('runner refuses non-EXECUTABLE workers: spotify-auth apply blocked by NOT_YET_APPROVED (DO lifecycle rollback blocker)', async () => {
  const payload = JSON.parse(readFileSync(GENERATED('spotify-auth'), 'utf8'));
  const rollbackPayload = JSON.parse(readFileSync(ROLLBACK('spotify-auth'), 'utf8'));
  const { transport } = makeTransport({ world: baseWorld('riot-proxy') });
  assert.equal(payload.apply_approval, 'NOT_YET_APPROVED');
  assert.throws(() => createRunner({
    worker: 'spotify-auth', account: ACCOUNT, payload, rollbackPayload,
    transport, log: () => {}, readFile: (p) => readFileSync(p), repoRoot: root,
  }), (e) => e instanceof RunnerAbort && e.reason === 'apply_not_approved');
  // The rollback template is likewise marked unsupported.
  assert.equal(rollbackPayload.rollback_supported, false);
});

test('allowlist refuses URLs outside the payload endpoints (no improvised reads, incl. error paths)', async () => {
  const world = baseWorld('riot-proxy');
  const { runner } = makeRunner('riot-proxy', world);
  // The pinned old-version-existence GET IS allowed (rollback prerequisite)...
  const ok = await runner.request('GET', `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/riot-proxy/versions/${OLD_PIN['riot-proxy'].ver}`, { kind: 'read' });
  assert.equal(ok.status, 200);
  // ...but any other id/version shape is refused.
  await assert.rejects(
    runner.request('GET', `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/riot-proxy/versions/WRONG`, { kind: 'read' }),
    (e) => e.reason === 'endpoint_not_allowed'
  );
});

test('logging safety: no PUT body or secret material ever reaches the log', async () => {
  const world = baseWorld('riot-proxy');
  const { runner, logs } = makeRunner('riot-proxy', world);
  await runner.runApply();
  const joined = logs.join('\n');
  assert.ok(!joined.includes('Bearer'), 'no bearer token in logs');
  assert.ok(!joined.includes('Content-Disposition'), 'no multipart bodies/boundaries logged');
  assert.ok(!joined.includes('unfancy-'), 'no multipart boundary logged');
  // URLs may appear; that is intended and safe.
  assert.ok(joined.includes('PUT https://api.cloudflare.com'));
});
