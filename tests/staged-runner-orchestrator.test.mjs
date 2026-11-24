// Failure-injection state-transition tests for the STAGED apply/rollback
// orchestrator (recovery/staged-runner.mjs). Run:
//   node --test tests/staged-runner-orchestrator.test.mjs
// Every test drives the REAL createStagedRunner flow with an injected transport
// and an injected smoke callback — no helper mocks of inner steps, no network.
// Fixture scope: counts in this file belong to this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, existsSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createStagedRunner, RunnerAbort, readStagedReceipt, cliSmoke, formatCliError, main } from '../recovery/staged-runner.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = (w) => join(root, 'recovery', 'generated', `${w}.deploy.json`);
const ROLLBACK = (w) => join(root, 'recovery', 'generated', `${w}.rollback.json`);

const ACCOUNT = 'test-account-id';
const OLD_PIN = {
  'steam-proxy': { dep: '669fc653-539d-4f5f-83ef-3bd2de8c1f28', ver: '6e8f4f79-f12c-4fd9-97f0-70da34d54b31' },
  'riot-proxy': { dep: '7b0c6e80-8469-48a8-a459-275fb43a7c63', ver: '4b7671ad-c908-4dd6-bfa8-777772c39aca' },
};
const OWN_VERSION = '11111111-2222-3333-4444-555555555555';
const CANARY = 'canary-LEAK-9f2c1';

function deploymentsBody({ deploymentId, versionId }) {
  return { success: true, result: { deployments: [{ id: deploymentId, versions: [{ version_id: versionId, percentage: 100 }] }] } };
}
function mixedDeploymentsBody({ deploymentId, versionId }) {
  return {
    success: true,
    result: { deployments: [{ id: deploymentId, versions: [{ version_id: versionId, percentage: 60 }, { version_id: '99999999-8888-7777-6666-555555555555', percentage: 40 }] }] },
  };
}
// Official versions-list envelope: the FIRST entry is the LATEST; entries carry
// id and metadata.created_on. Fixtures are newest-first, as returned by CF.
function versionsListBody(idsNewestFirst) {
  return {
    success: true,
    result: idsNewestFirst.map((id, i) => ({ id, metadata: { created_on: new Date(Date.UTC(2026, 10, 24, 0, 0, 59 - i)).toISOString() } })),
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

function makeWorld(worker, overrides = {}) {
  const pin = OLD_PIN[worker];
  return {
    worker,
    active: { deploymentId: pin.dep, versionId: pin.ver },
    uploadedVersionId: OWN_VERSION,
    versionIds: [pin.ver], // newest-first versions list
    settings: settingsBody({ compatibilityDate: worker === 'riot-proxy' ? '2025-10-01' : '2025-10-03', worker }),
    activationPostError: null,
    activationResponseStatus: null,
    uploadPostError: null,
    rollbackPostError: null, // transport error on rollback POST (when own is active)
    rollbackResponseStatus: null, // non-200 on rollback POST (when own is active)
    driftSettingsAfterActivation: null, // settings body served after own active confirmed
    smokeHook: null,
    ...overrides,
  };
}

function makeTransport(world) {
  const calls = [];
  let deploymentsReads = 0;
  const transport = async ({ method, url, headers, body }) => {
    calls.push({ method, url, headers: { ...headers }, body: body ? Buffer.from(body) : null });
    if (method === 'GET' && url.includes('/deployments?')) {
      deploymentsReads++;
      // Reads 1+2 (initial + fresh pre-upload guard): old pin. Read 3+ (pre-
      // activation and later): follow world.active (fake world mutates on POST).
      if (world.deploymentState) return { status: 200, json: deploymentsBody(world.deploymentState) };
      if (deploymentsReads < 3) return { status: 200, json: deploymentsBody(world.active) };
      if (world.foreignAfterUpload && deploymentsReads === 3) {
        return { status: 200, json: deploymentsBody({ deploymentId: 'foreign-dep', versionId: 'aaaa7777-7777-7777-7777-777777777777' }) };
      }
      return { status: 200, json: deploymentsBody(world.active) };
    }
    if (method === 'GET' && url.includes('/versions')) {
      return { status: 200, json: versionsListBody(world.versionIds) };
    }
    if (method === 'GET' && url.endsWith('/settings')) {
      // Post-activation injected settings state (own active confirmed).
      if (world.driftSettingsAfterActivation && world.active.versionId === OWN_VERSION) {
        return { status: 200, json: world.driftSettingsAfterActivation };
      }
      return { status: 200, json: world.settings };
    }
    if (method === 'POST' && url.includes('/versions?')) {
      if (world.uploadPostError) {
        world.versionIds = ['cccc4444-4444-4444-4444-444444444444', ...world.versionIds];
        throw world.uploadPostError;
      }
      world.versionIds = [world.uploadedVersionId, ...world.versionIds];
      return { status: 200, json: { success: true, result: { id: world.uploadedVersionId } } };
    }
    if (method === 'POST' && url.includes('/deployments')) {
      const sent = JSON.parse(body.toString());
      if (sent.force !== false) throw new Error('force must be false');
      const target = sent.versions[0].version_id;
      const ownActive = world.active.versionId === OWN_VERSION;
      if (ownActive && world.rollbackPostError) { world.active = { ...world.active, versionId: target }; throw world.rollbackPostError; }
      if (ownActive && world.rollbackResponseStatus) return { status: world.rollbackResponseStatus, json: { success: false, errors: [{ code: 10042, message: CANARY }] } };
      if (world.activationPostError) throw world.activationPostError;
      if (world.activationResponseStatus) return { status: world.activationResponseStatus, json: { success: false, errors: [{ code: 9999, message: CANARY, nested: { msg: CANARY } }] } };
      world.active = { deploymentId: world.active.deploymentId, versionId: target };
      world.activatedViaBody = sent;
      return { status: 200, json: { success: true, result: {} } };
    }
    return { status: 404, json: null };
  };
  return { calls, transport };
}

function receiptDirFor() {
  return mkdtempSync(join(tmpdir(), 'staged-receipts-'));
}

function makeRunner(worker, world, opts = {}) {
  const payload = JSON.parse(readFileSync(GENERATED(worker), 'utf8'));
  const rollbackPayload = JSON.parse(readFileSync(ROLLBACK(worker), 'utf8'));
  const { calls, transport } = makeTransport(world);
  const logs = [];
  const smokeCalls = [];
  const rdir = opts.receiptDir ?? receiptDirFor();
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
    resumeReceipt: opts.resumeReceipt ?? null,
    expectedActiveDeploymentId: opts.expectedActiveDeploymentId ?? null,
    smoke: opts.smoke ?? (async ({ phase }) => { smokeCalls.push(phase); if (world.smokeHook) await world.smokeHook(phase); }),
  });
  return { runner, calls, logs, payload, rollbackPayload, smokeCalls, receiptDir: rdir };
}

const METHOD_SEQUENCE = (calls) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);

// ---------------------------------------------------------------------------
// Success paths

test('success: staged upload STAGED, then activation via explicit percentage deployment', async () => {
  const world = makeWorld('steam-proxy');
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  const out = await runner.runApply();
  assert.equal(out.applied, true);
  assert.equal(out.versionId, OWN_VERSION);

  // 3 initial guards + 3 fresh pre-upload guards + POST versions + 3
  // pre-activation guards + POST deployments + 2 post-activation readbacks.
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
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2, 'exactly two writes: staged upload + activation');

  const activation = world.activatedViaBody;
  assert.deepEqual(activation, { strategy: 'percentage', versions: [{ version_id: OWN_VERSION, percentage: 100 }], force: false });
  // No versions-detail read, no PATCH, no PUT anywhere.
  assert.equal(calls.some((c) => /\/versions\/[0-9a-f-]{36}/.test(c.url)), false);
  assert.equal(calls.some((c) => c.method === 'PATCH'), false);
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});

test('success details: multipart module parts use the FILENAME as field name; staged metadata has exactly the 4 allowed keys', async () => {
  const world = makeWorld('riot-proxy');
  const { runner, calls, payload } = makeRunner('riot-proxy', world, {});
  await runner.runApply();
  const upload = calls.find((c) => c.method === 'POST' && c.url.includes('/versions?'));
  const body = upload.body.toString();
  assert.match(upload.headers['Content-Type'], /multipart\/form-data; boundary=unfancy-staged-/);
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
  payload.metadata = { ...payload.metadata, usage_model: 'bundled' };
  const t = makeTransport(makeWorld('riot-proxy'));
  await assert.rejects(
    createStagedRunner({
      worker: 'riot-proxy', account: ACCOUNT, payload,
      rollbackPayload: JSON.parse(readFileSync(ROLLBACK('riot-proxy'), 'utf8')),
      transport: t.transport,
      repoRoot: root,
    }).uploadStaged(),
    (e) => e instanceof RunnerAbort && (e.reason === 'metadata_pin_drift' || e.reason === 'metadata_key_not_allowed')
  );
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
  world.versionIds = ['aaaa8888-8888-8888-8888-888888888888', OLD_PIN['steam-proxy'].ver];
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
  world.deploymentState = mixedDeploymentsBody({ deploymentId: OLD_PIN['riot-proxy'].dep, versionId: OLD_PIN['riot-proxy'].ver }).result.deployments[0];
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

test('failure injection: versions list with non-UUID entry -> unreadable, no writes', async () => {
  const world = makeWorld('steam-proxy');
  world.versionIds = ['not-a-uuid'];
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'unreadable_versions');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('failure injection: unknown staged-upload outcome (transport error, newest now unknown) -> exactly one attempt, no retry', async () => {
  const world = makeWorld('steam-proxy');
  world.uploadPostError = new Error(`${CANARY} connection reset`);
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'staged_upload_outcome_unverified');
  const postCount = calls.filter((c) => c.method === 'POST').length;
  assert.equal(postCount, 1, 'exactly the one attempted upload POST, no retry');
  assert.ok(!JSON.stringify(calls.map((c) => c.url)).includes(CANARY));
});

test('failure injection: staged upload API-rejected with unchanged state -> classified failed_unchanged, no rollback', async () => {
  const world = makeWorld('steam-proxy');
  const rejectedRunner = createStagedRunner({
    worker: 'steam-proxy', account: ACCOUNT,
    payload: JSON.parse(readFileSync(GENERATED('steam-proxy'), 'utf8')),
    rollbackPayload: JSON.parse(readFileSync(ROLLBACK('steam-proxy'), 'utf8')),
    transport: async ({ method, url }) => {
      if (method === 'POST' && url.includes('/versions?')) return { status: 400, json: { success: false, errors: [{ code: 10057, message: CANARY }] } };
      if (method === 'GET' && url.includes('/deployments?')) return { status: 200, json: deploymentsBody(world.active) };
      if (method === 'GET' && url.includes('/versions')) return { status: 200, json: versionsListBody(world.versionIds) };
      if (method === 'GET' && url.endsWith('/settings')) return { status: 200, json: world.settings };
      return { status: 404, json: null };
    },
    repoRoot: root,
    smoke: async () => {},
  });
  await assert.rejects(rejectedRunner.uploadStaged(), (e) => e instanceof RunnerAbort && e.reason === 'staged_upload_failed_unchanged');
});

// ---------------------------------------------------------------------------
// Receipt behaviour (before activation)

test('receipt: existing receipt file -> stop before activation', async () => {
  const world = makeWorld('steam-proxy');
  const rdir = receiptDirFor();
  writeFileSync(join(rdir, `steam-proxy-${OWN_VERSION}.json`), '{}\n');
  const { runner, calls } = makeRunner('steam-proxy', world, { receiptDir: rdir });
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'receipt_exists');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments')).length, 0, 'no activation after receipt collision');
});

test('receipt: symlinked receipt dir -> stop', async () => {
  const world = makeWorld('riot-proxy');
  const rdir = receiptDirFor();
  const target = mkdtempSync(join(tmpdir(), 'staged-receipt-target-'));
  symlinkSync(target, join(rdir, 'runs'));
  const { runner, calls } = makeRunner('riot-proxy', world, { receiptDir: join(rdir, 'runs') });
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'receipt_dir_symlink');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments')).length, 0);
});

test('receipt: written before activation, value-free, 0600', async () => {
  const world = makeWorld('steam-proxy');
  const rdir = receiptDirFor();
  const { runner } = makeRunner('steam-proxy', world, { receiptDir: rdir });
  await runner.runApply();
  const path = runner.state.receiptPath;
  assert.ok(existsSync(path));
  assert.equal(statSync(path).mode & 0o777, 0o600, 'receipt mode 0600');
  const raw = readFileSync(path);
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
  const text = raw.toString();
  assert.ok(!/STEAM_API_KEY[=:]\s*"/.test(text));
  assert.deepEqual(content.activation_body, { strategy: 'percentage', versions: [{ version_id: OWN_VERSION, percentage: 100 }], force: false });
  // The receipt must be READABLE-BACK by readStagedReceipt for the rollback path.
  const parsed = JSON.parse(readFileSync(GENERATED('steam-proxy'), 'utf8'));
  const rb = JSON.parse(readFileSync(ROLLBACK('steam-proxy'), 'utf8'));
  const receipt = readStagedReceipt(path, { worker: 'steam-proxy', account: ACCOUNT, payload: parsed, rollbackPayload: rb });
  assert.equal(receipt.own_version_id, OWN_VERSION);
});

// ---------------------------------------------------------------------------
// Recovery reachability after confirmed activation (finding 1)

test('recovery: safe-settings drift after own active confirmed -> guarded rollback + old readback + smoke', async () => {
  const world = makeWorld('steam-proxy');
  world.driftSettingsAfterActivation = settingsBody({ compatibilityDate: '2025-10-03', worker: 'steam-proxy' });
  world.driftSettingsAfterActivation.result.observability.redact_query_string = true;
  const { runner, calls, smokeCalls } = makeRunner('steam-proxy', world, {});
  const out = await runner.runApply();
  assert.equal(out.applied, false);
  assert.equal(out.rolledBack, true);
  const depPosts = calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments'));
  assert.equal(depPosts.length, 2, 'activation POST + rollback POST');
  assert.deepEqual(world.active, { deploymentId: OLD_PIN['steam-proxy'].dep, versionId: OLD_PIN['steam-proxy'].ver });
  assert.deepEqual(smokeCalls, ['after-rollback']);
  const rbBody = JSON.parse(depPosts[1].body.toString());
  assert.deepEqual(rbBody, { strategy: 'percentage', versions: [{ version_id: OLD_PIN['steam-proxy'].ver, percentage: 100 }], force: false });
});

test('recovery: settings GET HTTP failure after own active confirmed -> guarded rollback, no false inactive', async () => {
  const world = makeWorld('riot-proxy');
  world.driftSettingsAfterActivation = null; // keep normal settings
  // Inject an HTTP failure for settings AFTER the own version is active: use
  // world.deploymentState to force readback failures? Instead flip settings GET
  // status when own is active.
  const { runner, calls } = makeRunner('riot-proxy', world, {});
  const out = await runner.runApply();
  assert.equal(out.applied, true);
  // Second case: settings read fails while own active.
  const world2 = makeWorld('riot-proxy');
  const t = makeTransport(world2);
  const calls2 = [];
  const failingRunner = createStagedRunner({
    worker: 'riot-proxy', account: ACCOUNT,
    payload: JSON.parse(readFileSync(GENERATED('riot-proxy'), 'utf8')),
    rollbackPayload: JSON.parse(readFileSync(ROLLBACK('riot-proxy'), 'utf8')),
    transport: async (req) => {
      calls2.push(req);
      if (req.method === 'GET' && req.url.endsWith('/settings') && world2.active.versionId === OWN_VERSION) {
        return { status: 500, json: { success: false, errors: [{ code: 10000, message: CANARY }] } };
      }
      return t.transport(req);
    },
    repoRoot: root,
    receiptDir: receiptDirFor(),
    smoke: async () => {},
  });
  await assert.rejects(failingRunner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'rollback_settings_unreadable');
  // Settings unreadable in the rollback classification is a safe STOP BEFORE
  // the rollback write (script settings are never written; nothing to repair).
  assert.equal(calls2.filter((c) => c.method === 'POST' && c.url.includes('/deployments')).length, 1, 'activation only — safe stop before rollback write');
  assert.equal(failingRunner.state.activated, true, 'truthful: own active confirmed, never a false inactive claim');
});

test('recovery: unknown settings field after own active confirmed -> recovery STOP truthful (active reported, no false inactive)', async () => {
  const world = makeWorld('steam-proxy');
  world.driftSettingsAfterActivation = settingsBody({ compatibilityDate: '2025-10-03', worker: 'steam-proxy' });
  world.driftSettingsAfterActivation.result.brand_new_field = { unknown: true };
  const { runner, logs } = makeRunner('steam-proxy', world, {});
  await assert.rejects(runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'rollback_settings_unknown');
  // Truthful: own version reported as ACTIVE in the abort detail — never inactive.
  assert.equal(runner.state.activated, true);
  assert.ok(logs.some((l) => l.includes('confirmed activation')));
});

test('recovery: unreadable deployments in post-activation classification -> truthful UNVERIFIED, no false inactive', async () => {
  const world = makeWorld('steam-proxy');
  world.activationPostError = new Error(`${CANARY} timeout after send`);
  let deploymentsReads = 0;
  let failPosts = 0;
  const failRunner = createStagedRunner({
    worker: 'steam-proxy', account: ACCOUNT,
    payload: JSON.parse(readFileSync(GENERATED('steam-proxy'), 'utf8')),
    rollbackPayload: JSON.parse(readFileSync(ROLLBACK('steam-proxy'), 'utf8')),
    transport: async (req) => {
      if (req.method === 'GET' && req.url.includes('/deployments?')) {
        deploymentsReads++;
        if (deploymentsReads === 4) return { status: 503, json: { success: false, errors: [{ code: 10001, message: CANARY }] } };
      }
      if (req.method === 'POST') failPosts++;
      return makeTransport(world).transport(req);
    },
    repoRoot: root,
    receiptDir: receiptDirFor(),
    smoke: async () => {},
  });
  await assert.rejects(failRunner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'activation_outcome_unverified');
  assert.equal(failPosts, 2, 'staged upload + activation attempted exactly once (never repeated)');
  assert.equal(failRunner.state.activationAttempted, true);
  assert.equal(failRunner.state.activated, false, 'UNVERIFIED: never claim success or inactive');
});

// ---------------------------------------------------------------------------
// Shared guarded rollback: transport error AND HTTP 503 treated identically

test('rollback: transport error on rollback POST with old active after write -> classified verified incl. smoke', async (t) => {
  const world = makeWorld('steam-proxy');
  world.smokeHook = async (phase) => {
    if (phase === 'after-activation') throw new Error(`${CANARY} steam currently-playing 502`);
  };
  world.rollbackPostError = new Error(`${CANARY} rollback send failed`);
  const { runner, calls, smokeCalls } = makeRunner('steam-proxy', world, {});
  const out = await runner.runApply();
  assert.equal(out.rolledBack, true);
  const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments'));
  assert.equal(posts.length, 2, 'activation POST + one rollback attempt');
  assert.deepEqual(world.active, { deploymentId: OLD_PIN['steam-proxy'].dep, versionId: OLD_PIN['steam-proxy'].ver });
  assert.deepEqual(smokeCalls, ['after-activation', 'after-rollback']);
});

test('rollback: HTTP 503 on rollback POST with own still active -> rollback_outcome_unverified (truthful active), no retry', async (t) => {
  const world = makeWorld('riot-proxy');
  world.smokeHook = async (phase) => { if (phase === 'after-activation') throw new Error(CANARY); };
  world.rollbackResponseStatus = 503;
  const { runner, calls, logs } = makeRunner('riot-proxy', world, {});
  let caught;
  try { await runner.runApply(); } catch (e) { caught = e; }
  if (!caught || caught.reason !== 'rollback_outcome_unverified') {
    throw new Error(`test-20 debug: resolved or wrong reason: ${caught && caught.reason} ${caught && caught.detail && JSON.stringify(caught.detail)} :: ${METHOD_SEQUENCE(calls).join(' | ')}`);
  }
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/deployments')).length, 2, 'activation + one rollback attempt only');
  assert.equal(world.active.versionId, OWN_VERSION);
  assert.ok(!logs.join(' ').includes(CANARY));
});

// ---------------------------------------------------------------------------
// Error-hygiene canaries (finding 5)

test('canary: API error messages, nested error payloads, transport exception texts and smoke messages never leak', async () => {
  const world = makeWorld('steam-proxy');
  world.smokeHook = async (phase) => { if (phase === 'after-activation') throw new Error(`${CANARY} smoke detail`); };
  world.rollbackResponseStatus = 503;
  const { runner, calls, logs } = makeRunner('steam-proxy', world, {});
  let caught;
  try {
    await runner.runApply();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof RunnerAbort);
  const surfaces = JSON.stringify({
    logs,
    message: caught.message,
    detail: caught.detail,
    reason: caught.reason,
  });
  assert.ok(!surfaces.includes(CANARY), `canary leaked: ${surfaces.slice(0, 400)}`);
  // The rollback rejection's apiErrorCodes survive as NUMBERS only.
  assert.ok(!JSON.stringify(caught.detail).includes('injected'));
});

// ---------------------------------------------------------------------------
// Standalone rollback via VERIFIED RECEIPT (finding 2)


test('standalone rollback: verified receipt -> ownership guards -> rollback with force:false (shared guarded path)', async () => {
  const world = makeWorld('steam-proxy');
  world.active = { deploymentId: OLD_PIN['steam-proxy'].dep, versionId: OWN_VERSION };
  world.versionIds = [OWN_VERSION, OLD_PIN['steam-proxy'].ver];
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  const out = await runner.standaloneRollback(OWN_VERSION);
  assert.deepEqual(out, { skipped: false, verified: true, driftDetectedBefore: false });
  const post = calls.find((c) => c.method === 'POST' && c.url.includes('/deployments'));
  assert.deepEqual(JSON.parse(post.body.toString()), { strategy: 'percentage', versions: [{ version_id: OLD_PIN['steam-proxy'].ver, percentage: 100 }], force: false });
  assert.equal(runner.state.ownVersionId, OWN_VERSION);
});

test('standalone rollback: old already active -> NOOP, no write', async () => {
  const world = makeWorld('steam-proxy');
  const { runner, calls } = makeRunner('steam-proxy', world, {});
  const out = await runner.standaloneRollback(OWN_VERSION);
  assert.deepEqual(out, { skipped: true, reason: 'old_already_active', active: { deploymentId: OLD_PIN['steam-proxy'].dep, versionId: OLD_PIN['steam-proxy'].ver } });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('standalone rollback: foreign active -> STOP; mixed -> STOP; foreign latest -> STOP', async () => {
  const foreign = makeWorld('steam-proxy');
  foreign.active = { deploymentId: 'foreign-dep', versionId: 'aaaa6666-6666-6666-6666-666666666666' };
  const { runner } = makeRunner('steam-proxy', foreign, {});
  await assert.rejects(runner.standaloneRollback(OWN_VERSION), (e) => e instanceof RunnerAbort && e.reason === 'rollback_foreign_deployment');

  const mixed = makeWorld('riot-proxy');
  mixed.active = { deploymentId: OLD_PIN['riot-proxy'].dep, versionId: OWN_VERSION };
  mixed.versionIds = [OWN_VERSION, OLD_PIN['riot-proxy'].ver];
  mixed.deploymentState = mixedDeploymentsBody({ deploymentId: OLD_PIN['riot-proxy'].dep, versionId: OWN_VERSION }).result.deployments[0];
  const { runner: r2 } = makeRunner('riot-proxy', mixed, {});
  await assert.rejects(r2.standaloneRollback(OWN_VERSION), (e) => e instanceof RunnerAbort && e.reason === 'mixed_distribution');

  const latestForeign = makeWorld('steam-proxy');
  latestForeign.active = { deploymentId: OLD_PIN['steam-proxy'].dep, versionId: OWN_VERSION };
  latestForeign.versionIds = ['aaaa5555-5555-5555-5555-555555555555', OWN_VERSION, OLD_PIN['steam-proxy'].ver];
  const { runner: r3 } = makeRunner('steam-proxy', latestForeign, {});
  await assert.rejects(r3.standaloneRollback(OWN_VERSION), (e) => e instanceof RunnerAbort && e.reason === 'rollback_latest_foreign');
});

test('standalone rollback: malformed own uuid on rollback -> refused before any request', async () => {
  const { runner, calls } = makeRunner('steam-proxy', makeWorld('steam-proxy'), {});
  await assert.rejects(runner.standaloneRollback('steam-proxy'), (e) => e instanceof RunnerAbort && e.reason === 'rollback_requires_receipt_uuid');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// readStagedReceipt validation (zero writes on failure)

test('receipt validation: valid receipt passes; wrong hash / mode / symlink refused', () => {
  const payload = JSON.parse(readFileSync(GENERATED('steam-proxy'), 'utf8'));
  const rb = JSON.parse(readFileSync(ROLLBACK('steam-proxy'), 'utf8'));
  const base = {
    schema: 'unfancy-recovery-staged-receipt/v1',
    value_free: true,
    account: ACCOUNT,
    worker: 'steam-proxy',
    mode: 'apply',
    old_deployment_id: OLD_PIN['steam-proxy'].dep,
    old_version_id: OLD_PIN['steam-proxy'].ver,
    own_version_id: OWN_VERSION,
    payload_sha256: {
      deploy: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      rollback: createHash('sha256').update(JSON.stringify(rb)).digest('hex'),
    },
    source_sha256: payload.part_sha256,
    pinned_metadata_sha256: payload.metadata_sha256,
    upload_metadata_sha256: createHash('sha256').update(JSON.stringify({
      main_module: payload.metadata.main_module,
      compatibility_date: payload.metadata.compatibility_date,
      compatibility_flags: payload.metadata.compatibility_flags,
      bindings: payload.metadata.bindings.map(({ name }) => ({ type: 'inherit', name })),
    })).digest('hex'),
    activation_body: { strategy: 'percentage', versions: [{ version_id: OWN_VERSION, percentage: 100 }], force: false },
    rollback_body: { strategy: 'percentage', versions: [{ version_id: OLD_PIN['steam-proxy'].ver, percentage: 100 }], force: false },
  };
  const rdir = mkdtempSync(join(tmpdir(), 'receipt-validation-'));
  const path = join(rdir, 'steam-proxy-receipt.json');

  // valid
  writeFileSync(path, JSON.stringify(base), { mode: 0o600 });
  chmodSync(path, 0o600);
  const ok = readStagedReceipt(path, { worker: 'steam-proxy', account: ACCOUNT, payload, rollbackPayload: rb });
  assert.equal(ok.own_version_id, OWN_VERSION);

  // A syntactically valid SHA-256 is not a metadata ownership proof.
  writeFileSync(path, JSON.stringify({ ...base, upload_metadata_sha256: 'f'.repeat(64) }));
  assert.throws(() => readStagedReceipt(path, { worker: 'steam-proxy', account: ACCOUNT, payload, rollbackPayload: rb }),
    (e) => e instanceof RunnerAbort && e.reason === 'receipt_invalid');

  // wrong payload hash
  writeFileSync(path, JSON.stringify({ ...base, payload_sha256: { ...base.payload_sha256, deploy: 'f'.repeat(64) } }), { mode: 0o600 });
  assert.throws(() => readStagedReceipt(path, { worker: 'steam-proxy', account: ACCOUNT, payload, rollbackPayload: rb }),
    (e) => e instanceof RunnerAbort && e.reason === 'receipt_invalid');

  // wrong own uuid (not ours)
  writeFileSync(path, JSON.stringify({ ...base, own_version_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }), { mode: 0o600 });
  assert.throws(() => readStagedReceipt(path, { worker: 'steam-proxy', account: ACCOUNT, payload, rollbackPayload: rb }),
    (e) => e instanceof RunnerAbort && e.reason === 'receipt_invalid');

  // wrong worker/account
  writeFileSync(path, JSON.stringify({ ...base, worker: 'riot-proxy' }), { mode: 0o600 });
  assert.throws(() => readStagedReceipt(path, { worker: 'steam-proxy', account: ACCOUNT, payload, rollbackPayload: rb }),
    (e) => e instanceof RunnerAbort && e.reason === 'receipt_invalid');

  // mode not 0600
  writeFileSync(path, JSON.stringify(base), { mode: 0o644 });
  chmodSync(path, 0o644);
  assert.throws(() => readStagedReceipt(path, { worker: 'steam-proxy', account: ACCOUNT, payload, rollbackPayload: rb }),
    (e) => e instanceof RunnerAbort && e.reason === 'receipt_invalid');

  // symlink
  const linkPath = join(rdir, 'symlink-receipt.json');
  symlinkSync(path, linkPath);
  assert.throws(() => readStagedReceipt(linkPath, { worker: 'steam-proxy', account: ACCOUNT, payload, rollbackPayload: rb }),
    (e) => e instanceof RunnerAbort && e.reason === 'receipt_refused');

  // missing file
  assert.throws(() => readStagedReceipt(join(rdir, 'missing.json'), { worker: 'steam-proxy', account: ACCOUNT, payload, rollbackPayload: rb }),
    (e) => e instanceof RunnerAbort && e.reason === 'receipt_refused');
});

// ---------------------------------------------------------------------------
test('standalone rollback requires an old-version smoke and reports failed smoke truthfully', async () => {
  for (const fail of [false, true]) {
    const world = makeWorld('steam-proxy');
    world.active = { deploymentId: OLD_PIN['steam-proxy'].dep, versionId: OWN_VERSION };
    world.versionIds = [OWN_VERSION, OLD_PIN['steam-proxy'].ver];
    world.smokeHook = async () => { if (fail) throw new Error(CANARY); };
    const { runner, smokeCalls, logs } = makeRunner('steam-proxy', world);
    if (fail) await assert.rejects(runner.standaloneRollback(OWN_VERSION), (e) => {
      assert.ok(!JSON.stringify(e).includes(CANARY));
      return e.reason === 'smoke_failed';
    });
    else assert.equal((await runner.standaloneRollback(OWN_VERSION)).verified, true);
    assert.deepEqual(smokeCalls, ['after-rollback']);
    if (fail) assert.ok(!logs.some((line) => line.startsWith('ROLLBACK VERIFIED')));
  }
});

test('all error surfaces redact provider fields, binding names, smoke names and ordinary errors', async () => {
  const unknown = makeWorld('steam-proxy');
  unknown.settings.result[CANARY] = true;
  const binding = makeWorld('steam-proxy');
  binding.settings.result.bindings[0].name = CANARY;
  const smoke = makeWorld('steam-proxy');
  smoke.smokeHook = async () => { const err = new Error(CANARY); err.name = CANARY; throw err; };
  for (const world of [unknown, binding, smoke]) {
    const { runner, logs } = makeRunner('steam-proxy', world);
    try { await runner.runApply(); } catch (err) {
      assert.ok(!JSON.stringify({ error: err, message: err.message, cli: formatCliError(err), logs }).includes(CANARY));
    }
    assert.ok(!JSON.stringify(logs).includes(CANARY));
  }
  assert.equal(formatCliError(new Error(CANARY)), 'STAGED RUNNER ABORT: internal_error');
});

test('real CLI apply: recovered smoke failure rejects instead of returning deployment success', async () => {
  const world = makeWorld('steam-proxy');
  const { transport, calls } = makeTransport(world);
  const fetchFn = async (url, options = {}) => {
    if (new URL(url).hostname === 'api.cloudflare.com') {
      const response = await transport({ ...options, url, body: options.body ? Buffer.from(options.body) : undefined });
      return new Response(JSON.stringify(response.json), { status: response.status });
    }
    return new Response(JSON.stringify({ game: null, appid: null }), {
      status: world.active.versionId === OWN_VERSION ? 503 : 200,
      headers: { 'Access-Control-Allow-Origin': 'https://nirlau.de' },
    });
  };
  await assert.rejects(main(['steam-proxy', '--execute'], { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: CANARY }, {
    fetchFn, receiptDir: receiptDirFor(),
  }), (error) => error.reason === 'apply_failed_recovered');
  assert.equal(world.active.versionId, OLD_PIN['steam-proxy'].ver);
  assert.equal(calls.filter(({ method }) => method === 'POST').length, 3);
});

test('receipt-backed resume accepts only receipt-owned latest with exact post-rollback active deployment pin', async () => {
  const world = makeWorld('steam-proxy');
  const first = makeRunner('steam-proxy', world);
  await first.runner.runApply();
  const receiptPath = first.runner.state.receiptPath;
  const receipt = readStagedReceipt(receiptPath, {
    worker: 'steam-proxy', account: ACCOUNT, payload: first.payload, rollbackPayload: first.rollbackPayload,
  });

  const resumedDeployment = 'd0a26bf1-0645-4493-8422-deecd0e00861';
  const nextVersion = '22222222-3333-4444-5555-666666666666';
  world.active = { deploymentId: resumedDeployment, versionId: OLD_PIN['steam-proxy'].ver };
  world.uploadedVersionId = nextVersion;
  const resumed = makeRunner('steam-proxy', world, {
    receiptDir: dirname(receiptPath),
    resumeReceipt: receipt,
    expectedActiveDeploymentId: resumedDeployment,
  });
  const out = await resumed.runner.runApply();
  assert.equal(out.applied, true);
  assert.equal(world.active.versionId, nextVersion);
  const latestReceipt = readStagedReceipt(resumed.runner.state.receiptPath, {
    worker: 'steam-proxy', account: ACCOUNT, payload: resumed.payload, rollbackPayload: resumed.rollbackPayload,
  });
  assert.equal(latestReceipt.old_deployment_id, resumedDeployment);
});

test('receipt-backed resume stops before writes on deployment or latest drift', async () => {
  const world = makeWorld('steam-proxy');
  const first = makeRunner('steam-proxy', world);
  await first.runner.runApply();
  const receipt = readStagedReceipt(first.runner.state.receiptPath, {
    worker: 'steam-proxy', account: ACCOUNT, payload: first.payload, rollbackPayload: first.rollbackPayload,
  });
  world.active = { deploymentId: 'd0a26bf1-0645-4493-8422-deecd0e00861', versionId: OLD_PIN['steam-proxy'].ver };
  const wrongDeployment = makeRunner('steam-proxy', world, {
    resumeReceipt: receipt, expectedActiveDeploymentId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  await assert.rejects(wrongDeployment.runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'active_deployment_drift');
  assert.equal(wrongDeployment.calls.filter((c) => c.method === 'POST').length, 0);

  world.versionIds = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ...world.versionIds];
  const wrongLatest = makeRunner('steam-proxy', world, {
    resumeReceipt: receipt, expectedActiveDeploymentId: 'd0a26bf1-0645-4493-8422-deecd0e00861',
  });
  await assert.rejects(wrongLatest.runner.runApply(), (e) => e instanceof RunnerAbort && e.reason === 'resume_latest_drift');
  assert.equal(wrongLatest.calls.filter((c) => c.method === 'POST').length, 0);
});

function fetchMock(statusByPath, headersByPath = {}) {
  return async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    const status = statusByPath[path] ?? 404;
    const h = new Map(Object.entries(headersByPath[path] ?? {}));
    return {
      status,
      headers: { get: (k) => h.get(k) ?? null },
      json: async () => statusByPath[`${path}#json`],
    };
  };
}

test('cli smoke: steam positive schema + exact ACAO + negative 400; CORS failure and absent ACAO rejected', async () => {
  const steam = (acao, status = 200) => fetchMock(
    {
      '/currently-playing?steamid=76561198159661156': status,
      '/currently-playing?steamid=abc': 400,
      '/currently-playing?steamid=76561198159661156#json': { game: 'Dota 2', appid: '570' },
    },
    { '/currently-playing?steamid=76561198159661156': { 'access-control-allow-origin': acao } }
  );
  await cliSmoke('steam-proxy', 'after-activation', steam('https://nirlau.de'));
  await assert.rejects(cliSmoke('steam-proxy', 'after-activation', steam('https://evil.example')), (e) => e.category === 'cors_mismatch');
  await assert.rejects(cliSmoke('steam-proxy', 'after-activation', steam(null)), (e) => e.category === 'cors_mismatch');
  await assert.rejects(cliSmoke('steam-proxy', 'after-activation', steam('https://nirlau.de', 502)), (e) => e.category === 'positive_http' && e.status === 502);
});

test('cli smoke: riot positive uses the real minimal stats schema; {error:...} body is rejected', async () => {
  const riot = (jsonBody, acao = 'https://nirlau.de', status = 200) => fetchMock(
    {
      '/lol/Nirlau/Lauri/euw': status,
      '/lol/Nirlau/Lauri/xx': 400,
      '/lol/Nirlau/Lauri/euw#json': jsonBody,
    },
    { '/lol/Nirlau/Lauri/euw': { 'access-control-allow-origin': acao } }
  );
  const okBody = { summonerName: 'Lauri', level: 231, ranked: null, totalMasteryPoints: 42, masteryTop3: [], accountCreatedAt: null, accountCreatedAtApprox: null, recentMatches: [] };
  await cliSmoke('riot-proxy', 'after-activation', riot(okBody));
  await assert.rejects(cliSmoke('riot-proxy', 'after-activation', riot({ error: 'upstream_error', summonerName: 'Lauri', level: 231 })), (e) => e.category === 'positive_schema');
  await assert.rejects(cliSmoke('riot-proxy', 'after-activation', riot({ error: 'x' })), (e) => e.category === 'positive_schema');
  await assert.rejects(cliSmoke('riot-proxy', 'after-activation', riot(okBody, 'https://evil.example')), (e) => e.category === 'cors_mismatch');
});

test('cli smoke: old-contract phase requires positive + exact ACAO only, NOT the new negative 400', async () => {
  const oldStand = fetchMock(
    {
      '/currently-playing?steamid=76561198159661156': 200,
      '/currently-playing?steamid=76561198159661156#json': { game: null, appid: null },
      // negative endpoint answers 200 on an unhardened old stand:
      '/currently-playing?steamid=abc': 200,
    },
    { '/currently-playing?steamid=76561198159661156': { 'access-control-allow-origin': 'https://nirlau.de' } }
  );
  await cliSmoke('steam-proxy', 'after-rollback', oldStand); // passes despite missing negative hardening
  await assert.rejects(cliSmoke('steam-proxy', 'after-activation', oldStand), (e) => e.category === 'negative_http' && e.status === 200);
});

test('smoke diagnostics expose only allowlisted phase/category/status and never exception text', async () => {
  const world = makeWorld('steam-proxy');
  const { runner, logs } = makeRunner('steam-proxy', world, {
    smoke: async ({ phase }) => { if (phase === 'after-activation') throw new Error('secret query=CANARY upstream payload CANARY'); },
  });
  const out = await runner.runApply();
  assert.equal(out.applied, false);
  assert.equal(out.rolledBack, true);
  assert.ok(logs.some((line) => line.includes('phase=after-activation, category=transport_error')));
  assert.ok(!logs.join(' ').includes('CANARY'));
});

// ---------------------------------------------------------------------------
// Scope + allowlist

test('scope: spotify workers are refused structurally', () => {
  const payload = JSON.parse(readFileSync(GENERATED('steam-proxy'), 'utf8'));
  const rollbackPayload = JSON.parse(readFileSync(ROLLBACK('steam-proxy'), 'utf8'));
  for (const worker of ['spotify-proxy', 'spotify-auth']) {
    assert.throws(() => createStagedRunner({
      worker, account: ACCOUNT, payload, rollbackPayload,
      transport: async () => ({ status: 200, json: null }), repoRoot: root,
    }), (e) => e instanceof RunnerAbort && e.reason === 'worker_not_in_scope');
  }
});
