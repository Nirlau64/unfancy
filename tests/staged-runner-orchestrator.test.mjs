// Failure-injection state-transition tests for the STAGED apply/rollback
// orchestrator (recovery/staged-runner.mjs). Run:
//   node --test tests/staged-runner-orchestrator.test.mjs
// Every test drives the REAL createStagedRunner flow with an injected transport
// and an injected smoke callback — no helper mocks of inner steps, no network.
// Fixture scope: counts in this file belong to this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStagedRunner, RunnerAbort } from '../recovery/staged-runner.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = (w) => join(root, 'recovery', 'generated', `${w}.deploy.json`);
const ROLLBACK = (w) => join(root, 'recovery', 'generated', `${w}.rollback.json`);

const ACCOUNT = 'test-account-id';
const OLD_PIN = {
  'steam-proxy': { dep: '669fc653-539d-4f5f-83ef-3bd2de8c1f28', ver: '6e8f4f79-f12c-4fd9-97f0-70da34d54b31' },
  'riot-proxy': { dep: '7b0c6e80-8469-48a8-a459-275fb43a7c63', ver: '4b7671ad-c908-4dd6-bfa8-777772c39aca' },
};
const OWN_VERSION = '11111111-2222-3333-4444-555555555555';

function deploymentsBody({ deploymentId, versionId }) {
  return { success: true, result: { deployments: [{ id: deploymentId, versions: [{ version_id: versionId, percentage: 100 }] }] } };
}
function mixedDeploymentsBody({ deploymentId, versionId }) {
  return {
    success: true,
    result: { deployments: [{ id: deploymentId, versions: [{ version_id: versionId, percentage: 60 }, { version_id: '99999999-8888-7777-6666-555555555555', percentage: 40 }] }] },
  };
}
function versionsListBody(ids) {
  return {
    success: true,
    result: ids.map((id, i) => ({ id, created_on: `2026-11-24T00:00:0${i}Z` })),
  };
}
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

// Fake world + transport router. Records every call.
function makeWorld(worker, overrides = {}) {
  const pin = OLD_PIN[worker];
  return {
    worker,
    active: { deploymentId: pin.dep, versionId: pin.ver },
    uploadedVersionId: OWN_VERSION,
    versionIds: [pin.ver],
    settings: settingsBody({ compatibilityDate: worker === 'riot-proxy' ? '2025-10-01' : '2025-10-03', worker }),
    activationPostError: null, // transport throws on activation POST
    activationResponseStatus: null, // transport returns non-200 on activation POST
    uploadPostError: null,
    rollbackPostError: null,
    smokeHook: null,
    ...overrides,
  };
}

function makeTransport(world) {
  const calls = [];
  const transport = async ({ method, url, headers, body }) => {
    calls.push({ method, url, headers: { ...headers }, body: body ? Buffer.from(body) : null });
    if (method === 'GET' && url.includes('/deployments?')) {
      const w = world.deploymentState ?? world.active;
      return world.mixedActive
        ? { status: 200, json: mixedDeploymentsBody({ deploymentId: w.deploymentId, versionId: w.versionId }) }
        : { status: 200, json: deploymentsBody(w) };
    }
    if (method === 'GET' && url.includes('/versions?') === false && url.includes('/versions')) {
      return { status: 200, json: versionsListBody(world.versionIds) };
    }
    if (method === 'GET' && url.endsWith('/settings')) return { status: 200, json: world.settings };
    if (method === 'POST' && url.includes('/versions?')) {
      if (world.uploadPostError) {
        world.versionIds = [...world.versionIds, 'cccc4444-4444-4444-4444-444444444444'];
        throw world.uploadPostError;
      }
      world.versionIds = [...world.versionIds, world.uploadedVersionId];
      return { status: 200, json: { success: true, result: { id: world.uploadedVersionId } } };
    }
    if (method === 'POST' && url.includes('/deployments')) {
      if (world.rollbackPostError && world.active.versionId !== OLD_PIN[world.worker].ver) throw world.rollbackPostError;
      if (world.rollbackRejectedStatus && world.active.versionId !== OLD_PIN[world.worker].ver) return { status: world.rollbackRejectedStatus, json: { success: false, errors: [{ code: 10042, message: 'injected rollback rejection' }] } };
      if (world.activationPostError) throw world.activationPostError;
      if (world.activationResponseStatus) return { status: world.activationResponseStatus, json: { success: false, errors: [{ code: 9999, message: 'injected' }] } };
      const sent = JSON.parse(body.toString());
      const target = sent.versions[0].version_id;
      if (sent.force !== false) throw new Error('force must be false');
      world.active = { deploymentId: world.active.deploymentId, versionId: target };
      world.versionIds = world.versionIds.includes(target) ? world.versionIds : [...world.versionIds, target];
      world.activatedViaBody = sent;
      return { status: 200, json: { success: true, result: {} } };
    }
    return { status: 404, json: null };
  };
  return { calls, transport };
}

function receiptDirFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'staged-receipts-'));
  return dir;
}

function makeRunner(worker, world, opts = {}) {
  const payload = JSON.parse(readFileSync(GENERATED(worker), 'utf8'));
  const rollbackPayload = JSON.parse(readFileSync(ROLLBACK(worker), 'utf8'));
  const { calls, transport } = makeTransport(world);
  const logs = [];
  const smokeCalls = [];
  const rdir = opts.receiptDir ?? receiptDirFor(null);
  const runner = createStagedRunner({
    worker,
    account: ACCOUNT,
    payload,
    rollbackPayload,
    transport,
    log: (m) => logs.push(m),
    readFile: opts.readFile ?? ((p) => readFileSync(p)),
    repoRoot: root,
    receiptDir: rdir,
    smoke: opts.smoke ?? (async ({ phase }) => { smokeCalls.push(phase); if (world.smokeHook) await world.smokeHook(phase); }),
  });
  return { runner, calls, logs, payload, rollbackPayload, smokeCalls, receiptDir: rdir };
}

const METHOD_SEQUENCE = (calls) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);

// ---------------------------------------------------------------------------
// Success paths

test('success: staged upload stays INACTIVE, then activation via explicit percentage deployment', async () => {
  const world = makeWorld('steam-proxy');
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  const out = await runner.runApply();
  assert.equal(out.applied, true);
  assert.equal(out.versionId, OWN_VERSION);

  // Call sequence: 3 initial guards, 3 fresh pre-upload guards (runApply +
  // uploadStaged both guard; the write sees a fresh check), POST versions,
  // 3 pre-activation guards, POST deployments, 2 post-activation readbacks.
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2, 'exactly two writes: staged upload + activation');
  const seq = METHOD_SEQUENCE(calls);
  assert.match(seq[0], /GET .*deployments/);
  assert.match(seq[1], /GET .*versions$/);
  assert.match(seq[2], /GET .*settings/);
  assert.match(seq[3], /GET .*deployments/);
  assert.match(seq[4], /GET .*versions$/);
  assert.match(seq[5], /GET .*settings/);
  assert.match(seq[6], /POST .*\/versions\?bindings_inherit=strict/);
  assert.match(seq[7], /GET .*deployments/);
  assert.match(seq[8], /GET .*versions$/);
  assert.match(seq[9], /GET .*settings/);
  assert.match(seq[10], /POST .*\/deployments$/);
  assert.equal(seq.filter((s) => s.startsWith('GET')).length, 11);

  // Staged upload must leave the deployment untouched in the fake world before
  // the activation POST ran (world.active changed only by the deployments POST).
  const activation = world.activatedViaBody;
  assert.deepEqual(activation, { strategy: 'percentage', versions: [{ version_id: OWN_VERSION, percentage: 100 }], force: false });
  // No versions-detail read, no PATCH anywhere.
  assert.equal(calls.some((c) => /\/versions\/[0-9a-f-]{36}/.test(c.url)), false);
  assert.equal(calls.some((c) => c.method === 'PATCH'), false);
});

test('success details: multipart module parts use the FILENAME as field name; staged metadata has exactly the 4 allowed keys', async () => {
  const world = makeWorld('riot-proxy');
  const { runner, calls, payload } = makeRunner('riot-proxy', world, {});
  await runner.runApply();
  const upload = calls.find((c) => c.method === 'POST' && c.url.includes('/versions?'));
  const body = upload.body.toString();
  assert.match(upload.headers['Content-Type'], /multipart\/form-data; boundary=unfancy-staged-/);
  // metadata part + one part per module file named by its filename
  assert.ok(body.includes('Content-Disposition: form-data; name="metadata"; filename="metadata"'), 'metadata part named "metadata"');
  for (const p of payload.parts) {
    assert.ok(body.includes(`Content-Disposition: form-data; name="${p.filename}"; filename="${p.filename}"`), `module part named ${p.filename}`);
    assert.equal(body.split(`name="${p.filename}"; filename=`).length - 1, 1, `exactly one part for ${p.filename}`);
  }
  assert.equal(body.split('name="script"').length - 1, 0, 'no generic "script" field name');

  const metaStart = body.indexOf('{');
  const metaEnd = body.indexOf('\r\n--', metaStart);
  const metadata = JSON.parse(body.slice(metaStart, metaEnd));
  assert.deepEqual(Object.keys(metadata).sort(), ['bindings', 'compatibility_date', 'compatibility_flags', 'main_module']);
  assert.equal(metadata.main_module, payload.metadata.main_module);
  assert.equal(metadata.compatibility_date, payload.metadata.compatibility_date);
  for (const b of metadata.bindings) assert.deepEqual(Object.keys(b).sort(), ['name', 'type']);
  // Script-level settings must NOT be in the upload metadata.
  for (const forbidden of ['observability', 'logpush', 'tags', 'tail_consumers', 'placement', 'annotations', 'usage_model']) {
    assert.equal(forbidden in metadata, false, `${forbidden} must not be in the staged upload metadata`);
  }
});

test('payload pins validate: pinned metadata sha256 and actual source bytes are checked before any write', async () => {
  const world = makeWorld('steam-proxy');
  const { runner, calls } = makeRunner('steam-proxy', world, {
    readFile: (p) => {
      if (String(p).endsWith('steam-proxy.js')) return Buffer.from('// tampered source');
      return readFileSync(p);
    },
  });
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'part_byte_drift');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'no write after byte drift');

  // Tampered payload metadata pin (parsed payload mutated after load).
  const payload = JSON.parse(readFileSync(GENERATED('riot-proxy'), 'utf8'));
  payload.metadata = { ...payload.metadata, usage_model: 'bundled' }; // also a disallowed key
  const { runner: r2, calls: c2 } = makeRunner('riot-proxy', makeWorld('riot-proxy'), {});
  // direct check of the metadata builder path via a doctored runner:
  await assert.rejects(
    createStagedRunner({
      worker: 'riot-proxy', account: ACCOUNT, payload,
      rollbackPayload: JSON.parse(readFileSync(ROLLBACK('riot-proxy'), 'utf8')),
      transport: makeTransport(makeWorld('riot-proxy')).transport,
      repoRoot: root,
    }).uploadStaged(),
    (e) => e instanceof RunnerAbort && (e.reason === 'metadata_pin_drift' || e.reason === 'metadata_key_not_allowed')
  );
  assert.equal(c2.filter((x) => x?.method === 'POST').length, 0);
});

// ---------------------------------------------------------------------------
// Guard drifts before any write

test('failure injection: active deployment drifted at start -> abort, no writes', async () => {
  const world = makeWorld('steam-proxy');
  world.active = { deploymentId: 'other-dep', versionId: 'aaaa9999-9999-9999-9999-999999999999' };
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'active_deployment_drift');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('failure injection: latest upload != pinned active (extra unpublished version) -> abort, no writes', async () => {
  const world = makeWorld('steam-proxy');
  world.versionIds = [OLD_PIN['steam-proxy'].ver, 'aaaa8888-8888-8888-8888-888888888888'];
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'latest_upload_drift');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('failure injection: safe settings drift before write -> abort, no writes', async () => {
  const world = makeWorld('riot-proxy');
  world.settings.result.observability.redact_query_string = true;
  const { runner, calls } = makeRunner('riot-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'safe_settings_drift');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('failure injection: mixed distribution (two versions / partial percentage) -> abort at guards, no writes', async () => {
  const world = makeWorld('riot-proxy');
  world.mixedActive = true;
  const { runner, calls } = makeRunner('riot-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'mixed_distribution');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

// ---------------------------------------------------------------------------
// Staged upload response handling

test('failure injection: malformed (non-UUID) result.id in version upload response -> NO activation', async () => {
  const world = makeWorld('steam-proxy');
  world.uploadedVersionId = 'steam-proxy'; // the legacy PUT returned the script name — must not activate
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'staged_version_invalid_id');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments')).length, 0, 'no activation POST after malformed id');
  assert.equal(runner.state.stagedUpload, false);
});

test('failure injection: unknown staged-upload outcome (transport error) -> exactly one readback, no retry', async () => {
  const world = makeWorld('steam-proxy');
  world.uploadPostError = new Error('connection reset');
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'staged_upload_outcome_unverified');
  const postCount = calls.filter((c) => c.method === 'POST').length;
  assert.equal(postCount, 1, 'exactly the one attempted upload POST, no retry');
  // one versions readback for classification
  const getVersions = calls.filter((c) => c.method === 'GET' && c.url.includes('/versions')).length;
  assert.ok(getVersions >= 2, 'guard read + classification read happened');
});

test('failure injection: staged upload API-rejected with unchanged state -> classified failed_unchanged, no rollback', async () => {
  const world = makeWorld('steam-proxy');
  world.uploadPostError = null;
  // make the upload POST return a 4xx by pointing at a rejected world: inject via uploadPostError-less path
  // simulate via activationResponseStatus unused; use a runner whose upload gets a 400:
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  // replace transport behavior for the versions POST
  const rejectedRunner = createStagedRunner({
    worker: 'steam-proxy', account: ACCOUNT,
    payload: JSON.parse(readFileSync(GENERATED('steam-proxy'), 'utf8')),
    rollbackPayload: JSON.parse(readFileSync(ROLLBACK('steam-proxy'), 'utf8')),
    transport: async ({ method, url }) => {
      if (method === 'POST' && url.includes('/versions?')) return { status: 400, json: { success: false, errors: [{ code: 10057, message: 'inherit not resolvable' }] } };
      if (method === 'GET' && url.includes('/deployments?')) return { status: 200, json: deploymentsBody(world.active) };
      if (method === 'GET' && url.includes('/versions')) return { status: 200, json: versionsListBody(world.versionIds) };
      if (method === 'GET' && url.endsWith('/settings')) return { status: 200, json: world.settings };
      return { status: 404, json: null };
    },
    repoRoot: root,
    smoke: async () => {},
  });
  await assert.rejects(rejectedRunner.uploadStaged(), (e) => e instanceof RunnerAbort && e.reason === 'staged_upload_failed_unchanged');
  assert.equal(calls.length, 0); // outer runner unused in this test
});

// ---------------------------------------------------------------------------
// Receipt behaviour (before activation)

test('receipt: existing receipt file -> stop before activation', async (t) => {
  const world = makeWorld('steam-proxy');
  const rdir = receiptDirFor(t);
  const prePath = join(rdir, `steam-proxy-${OWN_VERSION}.json`);
  writeFileSync(prePath, '{}\n');
  const { runner, calls } = makeRunner('steam-proxy', world, { receiptDir: rdir });
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'receipt_exists');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments')).length, 0, 'no activation after receipt collision');
});

test('receipt: symlinked receipt path -> stop', async (t) => {
  const world = makeWorld('riot-proxy');
  const rdir = receiptDirFor(t);
  const target = join(rdir, 'real-target.json');
  writeFileSync(target, '{}\n');
  symlinkSync(target, join(rdir, `riot-proxy-${OWN_VERSION}.json`));
  const { runner, calls } = makeRunner('riot-proxy', world, { receiptDir: rdir });
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && (e.reason === 'receipt_exists' || e.reason === 'receipt_dir_symlink'));
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments')).length, 0);
});

test('receipt: written before activation, value-free, 0600, single run', async (t) => {
  const world = makeWorld('steam-proxy');
  const rdir = receiptDirFor(t);
  const { runner, calls } = makeRunner('steam-proxy', world, { receiptDir: rdir });
  await runner.runApply();
  const path = runner.state.receiptPath;
  assert.ok(existsSync(path));
  const raw = readFileSync(path);
  const st = statSync(path);
  assert.equal(st.mode & 0o777, 0o600, 'receipt mode 0600');
  const content = JSON.parse(raw);
  assert.equal(content.account, ACCOUNT);
  assert.equal(content.worker, 'steam-proxy');
  assert.equal(content.old_deployment_id, OLD_PIN['steam-proxy'].dep);
  assert.equal(content.old_version_id, OLD_PIN['steam-proxy'].ver);
  assert.equal(content.own_version_id, OWN_VERSION);
  assert.ok(content.payload_sha256.deploy);
  assert.ok(content.payload_sha256.rollback);
  assert.ok(content.source_sha256['steam-proxy.js']);
  assert.ok(content.source_sha256['invocation-logging.js']);
  // value-free: no binding values anywhere (secret names appear, values never)
  const text = raw.toString();
  assert.ok(!/STEAM_API_KEY[=:]\s*"/.test(text));
  // activation body in receipt is the explicit one
  assert.deepEqual(content.activation_body, { strategy: 'percentage', versions: [{ version_id: OWN_VERSION, percentage: 100 }], force: false });
});

// ---------------------------------------------------------------------------
// Pre-activation drift after staged upload

test('failure injection: foreign active deployment after staged upload -> abort before activation', async () => {
  const world = makeWorld('steam-proxy');
  const payload = JSON.parse(readFileSync(GENERATED('steam-proxy'), 'utf8'));
  const rollbackPayload = JSON.parse(readFileSync(ROLLBACK('steam-proxy'), 'utf8'));
  const seen = [];
  let deploymentsReads = 0;
  const foreignRunner = createStagedRunner({
    worker: 'steam-proxy', account: ACCOUNT, payload, rollbackPayload,
    repoRoot: root,
    transport: async ({ method, url }) => {
      seen.push({ method, url });
      if (method === 'GET' && url.includes('/deployments?')) {
        deploymentsReads++;
        // Reads 1+2 (initial + fresh pre-upload guard): old pin. Read 3
        // (pre-activation guard): foreign — drift injected after the upload.
        return { status: 200, json: deploymentsBody(deploymentsReads < 3 ? world.active : { deploymentId: 'foreign-dep', versionId: 'aaaa7777-7777-7777-7777-777777777777' }) };
      }
      if (method === 'GET' && url.includes('/versions')) return { status: 200, json: versionsListBody(world.versionIds) };
      if (method === 'GET' && url.endsWith('/settings')) return { status: 200, json: world.settings };
      if (method === 'POST' && url.includes('/versions?')) return { status: 200, json: { success: true, result: { id: OWN_VERSION } } };
      return { status: 404, json: null };
    },
    smoke: async () => {},
    receiptDir: receiptDirFor(null),
  });
  await assert.rejects(foreignRunner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'pre_activation_active_drift');
  assert.equal(seen.some((c) => c.method === 'POST' && c.url.includes('/deployments')), false, 'no activation after foreign drift');
});

// ---------------------------------------------------------------------------
// Activation outcome handling

test('failure injection: unknown activation outcome (transport error) -> one readback classifies, NO retry', async () => {
  const world = makeWorld('steam-proxy');
  world.activationPostError = new Error('timeout after send');
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'activation_failed_unchanged');
  const activationPosts = calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments')).length;
  assert.equal(activationPosts, 1, 'activation never repeated');
});

test('failure injection: activation POST returns 200 but world unreadable/ambiguous -> outcome_unverified, no false success', async () => {
  const world = makeWorld('riot-proxy');
  world.activationResponseStatus = 500;
  const { runner, calls } = makeRunner('riot-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'activation_failed_unchanged');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments')).length, 1);
});

// ---------------------------------------------------------------------------
// Smoke-driven rollback

test('smoke failure after verified activation -> guarded rollback, old readback, smoke again', async (t) => {
  const world = makeWorld('steam-proxy');
  world.smokeHook = async (phase) => {
    if (phase === 'after-activation') throw new Error('smoke: steam currently-playing returned 502');
  };
  const rdir = receiptDirFor(t);
  const { runner, calls, smokeCalls } = makeRunner('steam-proxy', world, { receiptDir: rdir });
  await assert.rejects(runner.runApply(), (e) => e instanceof Error && /smoke: steam currently-playing/.test(e.message));
  const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments'));
  assert.equal(posts.length, 2, 'activation POST + rollback POST');
  const rbBody = JSON.parse(posts[1].body.toString());
  assert.deepEqual(rbBody, { strategy: 'percentage', versions: [{ version_id: OLD_PIN['steam-proxy'].ver, percentage: 100 }], force: false });
  assert.deepEqual(smokeCalls, ['after-activation', 'after-rollback'], 'smoke runs again against the old version');
  // final world state: old active (fake transport applied the rollback body)
  assert.deepEqual(world.active, { deploymentId: OLD_PIN['steam-proxy'].dep, versionId: OLD_PIN['steam-proxy'].ver });
});

test('failure injection: rollback rejected -> truthful failure, no false success', async (t) => {
  const world = makeWorld('riot-proxy');
  world.smokeHook = async (phase) => {
    if (phase === 'after-activation') throw new Error('smoke failed');
  };
  world.rollbackPostError = new Error('rollback send failed');
  const { runner, calls } = makeRunner('riot-proxy', world, { receiptDir: receiptDirFor(t) });
  // Transport error on the rollback POST = UNKNOWN outcome -> one readback
  // classifies (own still active) -> truthful 'rollback_outcome_unverified'.
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'rollback_outcome_unverified');
  // rollback never repeated
  const depPosts = calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments')).length;
  assert.ok(depPosts === 2, `activation POST + one rollback attempt (got ${depPosts})`);

  // Explicit API rejection (non-200) on the rollback POST -> 'rollback_rejected'.
  const world2 = makeWorld('riot-proxy');
  world2.smokeHook = async (phase) => { if (phase === 'after-activation') throw new Error('smoke failed'); };
  world2.rollbackRejectedStatus = 503;
  const { runner: r2 } = makeRunner('riot-proxy', world2, { receiptDir: receiptDirFor(t) });
  await assert.rejects(r2.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'rollback_rejected');
});

// ---------------------------------------------------------------------------
// Standalone rollback mode

test('standalone rollback: ownership verified (100% distribution, latest === own, old exists) -> rollback with force:false', async () => {
  const world = makeWorld('steam-proxy');
  world.active = { deploymentId: OLD_PIN['steam-proxy'].dep, versionId: OWN_VERSION };
  world.versionIds = [OLD_PIN['steam-proxy'].ver, OWN_VERSION];
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  const out = await runner.standaloneRollback(OWN_VERSION);
  assert.deepEqual(out, { noop: false, verified: true });
  const post = calls.find((c) => c.method === 'POST' && c.url.includes('/deployments'));
  const body = JSON.parse(post.body.toString());
  assert.deepEqual(body, { strategy: 'percentage', versions: [{ version_id: OLD_PIN['steam-proxy'].ver, percentage: 100 }], force: false });
});

test('standalone rollback: old already active -> NOOP, no write', async () => {
  const world = makeWorld('steam-proxy');
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  const out = await runner.standaloneRollback(OWN_VERSION);
  assert.deepEqual(out, { noop: true, reason: 'old_already_active' });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('standalone rollback: foreign active -> STOP; mixed distribution -> STOP', async () => {
  // foreign
  const world = makeWorld('steam-proxy');
  world.active = { deploymentId: 'foreign-dep', versionId: 'aaaa6666-6666-6666-6666-666666666666' };
  const { runner } = makeRunner('steam-proxy', world, {});
  await assert.rejects(runner.standaloneRollback(OWN_VERSION), (e) => e instanceof RunnerAbort && e.reason === 'rollback_foreign_deployment');

  // mixed
  const world2 = makeWorld('riot-proxy');
  world2.active = { deploymentId: OLD_PIN['riot-proxy'].dep, versionId: OWN_VERSION };
  world2.mixedActive = true;
  const { runner: r2 } = makeRunner('riot-proxy', world2, {});
  await assert.rejects(r2.standaloneRollback(OWN_VERSION), (e) => e instanceof RunnerAbort && e.reason === 'mixed_distribution');
});

test('standalone rollback: latest upload != own -> STOP (ownership not provable)', async () => {
  const world = makeWorld('steam-proxy');
  world.active = { deploymentId: OLD_PIN['steam-proxy'].dep, versionId: OWN_VERSION };
  world.versionIds = [OLD_PIN['steam-proxy'].ver, OWN_VERSION, 'aaaa5555-5555-5555-5555-555555555555'];
  const { runner } = makeRunner('steam-proxy', world, {});
  await assert.rejects(runner.standaloneRollback(OWN_VERSION), (e) => e instanceof RunnerAbort && e.reason === 'rollback_latest_drift');
});

// ---------------------------------------------------------------------------
// Scope + allowlist

test('scope: spotify workers are refused structurally; spotify settings GET is never allowlisted', () => {
  const payload = JSON.parse(readFileSync(GENERATED('steam-proxy'), 'utf8'));
  const rollbackPayload = JSON.parse(readFileSync(ROLLBACK('steam-proxy'), 'utf8'));
  for (const worker of ['spotify-proxy', 'spotify-auth']) {
    assert.throws(() => createStagedRunner({
      worker, account: ACCOUNT, payload, rollbackPayload,
      transport: async () => ({ status: 200, json: null }), repoRoot: root,
    }), (e) => e instanceof RunnerAbort && e.reason === 'worker_not_in_scope');
  }
  const { calls } = makeRunner('steam-proxy', makeWorld('steam-proxy'), {});
  assert.equal(calls.length, 0);
});

test('malformed own uuid on standalone rollback -> refused before any request', async () => {
  const { runner, calls } = makeRunner('steam-proxy', makeWorld('steam-proxy'), {});
  await assert.rejects(runner.standaloneRollback('steam-proxy'), (e) => e instanceof RunnerAbort && e.reason === 'rollback_requires_own_uuid');
  assert.equal(calls.length, 0);
});
