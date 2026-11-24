// Staged replacement runner for steam-proxy and riot-proxy (versions API, NOT the legacy PUT).
//
// Contract (official Cloudflare types, cloudflare-python main
// src/cloudflare/types/workers/scripts/version_create_params.py &
// deployment_create_params.py):
//  - Version upload metadata allows ONLY: main_module (required), annotations,
//    bindings, cache_options, compatibility_date, compatibility_flags, exports,
//    keep_bindings, package_dependencies, usage_model. This runner sends exactly
//    four of them: main_module, compatibility_date, compatibility_flags,
//    bindings (every entry {type:'inherit', name}). observability / logpush /
//    tags / tail_consumers / placement are script-level settings and are NEVER
//    sent — they must not be PATCHed either; they are verified before and after
//    every write for full equality instead.
//  - bindings type 'inherit' resolves against the LATEST UPLOAD, not the active
//    version. `bindings_inherit=strict` protects against a missing resolution,
//    NOT against latest != old-active value equality. Therefore the runner
//    guards latest === pinned-active before every write.
//  - POST /accounts/{account}/workers/scripts/{worker}/versions?bindings_inherit=strict
//    creates a STAGED (inactive) version; response result.id MUST be a UUID.
//    (The legacy PUT returned the script NAME as result.id — that mock era is gone;
//    here a non-UUID result.id aborts before any activation.)
//  - Activation: POST .../deployments JSON {strategy:'percentage',
//    versions:[{version_id:UUID, percentage:100}], force:false}.
//
// Safety contract (inherited from the reviewed runner design):
//  - Steam/riot ONLY. spotify workers are refused structurally.
//  - Transport is INJECTED: no network access inside this module. The CLI entry
//    takes the bearer token EXCLUSIVELY from process.env.CF_API_TOKEN (never
//    logged, never persisted, never forwarded to child processes; no
//    1Password variables are read or forwarded — the parent owns provisioning).
//  - Endpoint ALLOWLIST: every request must match an allowlisted pattern before
//    I/O, including on error paths. Forbidden reads (versions detail GET,
//    settings GET for spotify) are structurally impossible. No PATCH is ever
//    issued.
//  - Byte pinning: module part bytes are SHA-256-pinned per part in the payload;
//    the pinned full metadata JSON of the payload is re-verified against its
//    metadata_sha256 pin. The STAGED upload metadata is a strict subset built
//    from the pinned values; its own hash goes into the receipt.
//  - Multipart: the module part's form field NAME is the FILENAME (not
//    'script' for every part). The metadata part is name="metadata".
//  - Receipt BEFORE activation, value-free, O_CREAT|O_EXCL|O_NOFOLLOW mode 0600
//    under recovery/runs/ (gitignored): account, worker, old deployment id,
//    old UUID, own UUID, payload and source SHA-256 hashes. No binding values.
//  - Unknown write outcome: NO retry, NO blind repeat. Exactly one readback
//    classifies the outcome; if still unclear -> STOP 'unverified'.
//  - Smokes run in the SAME apply process via an injected smoke callback; on
//    smoke failure a guarded rollback runs (old pin readback + smoke again).
//  - Read-check-write without server-side compare-and-swap is NOT atomic. Every
//    guard is re-run freshly immediately before each write, and the post-write
//    readback classifies what actually happened — but a race between our read
//    and our write cannot be prevented by this runner. This boundary is real
//    and documented; the guards shrink the window, they do not close it.
import { readFileSync, openSync, writeSync, closeSync, mkdirSync, lstatSync, constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { projectSettings } from './readback-projection.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGED_RUNNERS = ['steam-proxy', 'riot-proxy'];
// Official version-create metadata keys. The runner sends the SUBSET below; any
// other key leaking into the built metadata is a bug and aborts.
const METADATA_ALLOWED_KEYS = new Set([
  'main_module', 'annotations', 'bindings', 'cache_options', 'compatibility_date',
  'compatibility_flags', 'exports', 'keep_bindings', 'package_dependencies', 'usage_model',
]);
const METADATA_SENT_KEYS = new Set(['main_module', 'compatibility_date', 'compatibility_flags', 'bindings']);

export class RunnerAbort extends Error {
  constructor(reason, detail = {}) {
    super(`STAGED RUNNER ABORT: ${reason}`);
    this.reason = reason;
    this.detail = detail;
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function endpointToRegex(pattern) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}(\\?.*)?$`);
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Complete single-version-100% distribution or nothing. A deployment whose
// versions array is missing, has several entries, or a percentage !== 100 is
// MIXED distribution — never a valid guard pin, never a valid rollback target.
function deploymentInfo(deploymentsJson) {
  const list = deploymentsJson?.result?.deployments;
  if (!Array.isArray(list) || list.length === 0) throw new RunnerAbort('unreadable_deployments');
  const d = list[0];
  const vs = d?.versions;
  if (!Array.isArray(vs) || vs.length !== 1 || vs[0]?.percentage !== 100 || !isUuid(vs[0]?.version_id)) {
    throw new RunnerAbort('mixed_distribution', { deploymentId: d?.id, versions: Array.isArray(vs) ? vs.length : String(vs) });
  }
  return { deploymentId: d.id, versionId: vs[0].version_id };
}

function newestVersionId(versionsJson) {
  const versions = versionsJson?.result?.items ?? versionsJson?.result;
  if (!Array.isArray(versions) || versions.length === 0) throw new RunnerAbort('unreadable_versions');
  const newest = versions.reduce((a, b) => (String(b.created_on ?? '') > String(a.created_on ?? '') ? b : a));
  return { newestId: newest.id, newestCreated: newest.created_on, list: versions };
}

// Compare projected live settings against the pinned full settings. Unknown
// fields abort (checked on the RAW result — the projection would drop them).
function compareSafeSettings(pinned, classifications, liveProjected) {
  for (const [key, cls] of Object.entries(classifications)) {
    if (cls === 'n.a.') continue;
    if (cls === 'absent') {
      if (liveProjected[key] !== undefined && liveProjected[key] !== null && liveProjected[key] !== '') {
        throw new RunnerAbort('safe_settings_drift', { field: key, classification: cls });
      }
      continue;
    }
    if (cls !== 'preserve') throw new RunnerAbort('unknown_classification', { field: key });
    if (JSON.stringify(liveProjected[key]) !== JSON.stringify(pinned[key])) {
      throw new RunnerAbort('safe_settings_drift', { field: key, classification: cls });
    }
  }
  return true;
}

function assertNoUnknownRawFields(rawResult, classifications) {
  for (const key of Object.keys(rawResult)) {
    if (key === 'bindings') continue;
    if (!(key in classifications)) throw new RunnerAbort('unknown_settings_field', { field: key });
  }
  return true;
}

function compareBindingInventory(pinnedInventory, liveBindings) {
  const pin = [...pinnedInventory].sort((a, b) => a.name.localeCompare(b.name));
  const live = [...liveBindings].sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(pin) !== JSON.stringify(live)) {
    throw new RunnerAbort('bindings_inventory_drift', {
      pinned: pin.map((b) => b.name),
      live: live.map((b) => b.name),
    });
  }
  return true;
}

// Build the staged multipart body: metadata part named "metadata", one module
// part per file with the FILENAME as the form field name.
function buildMultipartBody(metadataJson, parts) {
  const boundary = `unfancy-staged-${sha256(Buffer.from(metadataJson)).slice(0, 24)}`;
  const chunks = [];
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"; filename="metadata"\r\nContent-Type: application/json\r\n\r\n${metadataJson}\r\n`));
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.filename}"; filename="${p.filename}"\r\nContent-Type: ${p.contentType}\r\n\r\n`));
    chunks.push(p.bytes);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Value-free receipt before activation. O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600.
// Existing file or symlink -> STOP (no overwrite, no follow).
function writeReceipt(receiptPath, content) {
  let st;
  try {
    st = lstatSync(receiptPath);
    throw new RunnerAbort('receipt_exists', { path: receiptPath, kind: st.isSymbolicLink() ? 'symlink' : 'file' });
  } catch (err) {
    if (err instanceof RunnerAbort) throw err;
    if (err.code !== 'ENOENT') throw new RunnerAbort('receipt_unreadable', { path: receiptPath, code: err.code });
  }
  const dir = dirname(receiptPath);
  let dirSt;
  try {
    dirSt = lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      dirSt = lstatSync(dir);
    } else {
      throw new RunnerAbort('receipt_dir_unreadable', { dir, code: err.code });
    }
  }
  if (dirSt.isSymbolicLink()) throw new RunnerAbort('receipt_dir_symlink', { dir });
  if (!dirSt.isDirectory()) throw new RunnerAbort('receipt_dir_not_dir', { dir });
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  let fd;
  try {
    fd = openSync(receiptPath, flags, 0o600);
    writeSync(fd, JSON.stringify(content, null, 2) + '\n');
  } catch (err) {
    throw new RunnerAbort('receipt_write_failed', { path: receiptPath, code: err.code, message: err.message });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return content;
}

export function createStagedRunner({
  worker,
  account,
  payload, // parsed recovery/generated/<worker>.deploy.json — used ONLY as pin source
  rollbackPayload, // parsed recovery/generated/<worker>.rollback.json — used ONLY as pin source
  transport, // async ({method,url,headers,body}) -> {status, json, headers?}
  log = () => {}, // receives SAFE strings only (no bodies, no binding values)
  readFile = (p) => readFileSync(p),
  repoRoot = REPO_ROOT,
  receiptDir = join(REPO_ROOT, 'recovery', 'runs'),
  smoke, // async ({phase}) -> void; phases 'after-activation' | 'after-rollback'
}) {
  if (!STAGED_RUNNERS.includes(worker)) {
    throw new RunnerAbort('worker_not_in_scope', { worker, allowed: STAGED_RUNNERS });
  }
  if (!payload || !rollbackPayload || !transport) throw new Error('createStagedRunner: payload, rollbackPayload and transport are required');

  const base = payload.endpoint.replace('{ACCOUNT_ID}', account); // .../scripts/<worker>
  const deploymentsUrl = `${base}/deployments?per_page=1`;
  const versionsUrl = `${base}/versions`;
  const uploadUrl = `${base}/versions?bindings_inherit=strict`;
  const activateUrl = `${base}/deployments`;

  const allow = [
    { re: endpointToRegex(deploymentsUrl), method: 'GET' },
    { re: endpointToRegex(versionsUrl), method: 'GET' },
    { re: endpointToRegex(`${base}/settings`), method: 'GET' },
    { re: endpointToRegex(uploadUrl), method: 'POST' },
    { re: endpointToRegex(activateUrl), method: 'POST' },
  ];

  const guardSettings = payload.preapply_guards.full_settings;
  if (!guardSettings || guardSettings.skipped) {
    throw new RunnerAbort('settings_guard_required', { worker });
  }
  allow.push({ re: endpointToRegex(guardSettings.endpoint.replace('{ACCOUNT_ID}', account)), method: 'GET' });

  const oldPin = {
    deploymentId: rollbackPayload.pinned_live_deployment_id,
    versionId: rollbackPayload.pinned_live_version_id,
  };

  // Runtime state of THIS run.
  const state = {
    ownVersionId: null, // staged UUID from the version upload response
    receiptPath: null,
    stagedUpload: false,
    activated: false,
  };

  function assertAllowed(method, url) {
    const rule = allow.find((r) => r.method === method && r.re.test(url));
    if (!rule) throw new RunnerAbort('endpoint_not_allowed', { method, url, worker });
    return rule;
  }

  async function request(method, url, opts = {}) {
    assertAllowed(method, url);
    log(`${method} ${url}${opts.logNote ? ' — ' + opts.logNote : ''}`);
    const res = await transport({ method, url, headers: opts.headers ?? {}, body: opts.body });
    log(`  -> ${res?.status} ${method} ${url}`);
    return res;
  }

  // --- read guards ----------------------------------------------------------
  async function readDeployments() {
    const res = await request('GET', deploymentsUrl, { logNote: 'deployments guard' });
    if (res.status !== 200 || !res.json?.success) throw new RunnerAbort('guard_read_failed', { guard: 'deployments', status: res.status });
    return deploymentInfo(res.json);
  }

  async function readVersions() {
    const res = await request('GET', versionsUrl, { logNote: 'versions list guard' });
    if (res.status !== 200 || !res.json?.success) throw new RunnerAbort('guard_read_failed', { guard: 'versions_list', status: res.status });
    return { ...newestVersionId(res.json), raw: res.json };
  }

  async function readFullSettings() {
    const res = await request('GET', guardSettings.endpoint.replace('{ACCOUNT_ID}', account), { logNote: 'full safe settings guard (value-free projection)' });
    if (res.status !== 200 || !res.json?.success) throw new RunnerAbort('guard_read_failed', { guard: 'full_settings', status: res.status });
    assertNoUnknownRawFields(res.json.result, guardSettings.pinned_classifications);
    return res.json;
  }

  function checkSettings(json) {
    const projected = projectSettings(json);
    if (projected.compatibility_date !== payload.metadata.compatibility_date) {
      throw new RunnerAbort('compat_date_drift', { expected: payload.metadata.compatibility_date, live: projected.compatibility_date });
    }
    compareSafeSettings(
      { ...guardSettings.pinned_full_settings, compatibility_date: payload.metadata.compatibility_date },
      guardSettings.pinned_classifications,
      projected
    );
    const liveInventory = projected.bindings.map((b) => ({ name: b.name, type: b.type, ...(b.namespace_id ? { namespace_id: b.namespace_id } : {}) }));
    compareBindingInventory(guardSettings.live_bindings_inventory, liveInventory);
    return projected;
  }

  // Full initial guard set: active === pin (complete single-version 100%
  // distribution), latest upload === pin (inherit resolves against LATEST —
  // strict does not protect latest/active value equality), full safe settings.
  async function initialGuards() {
    const active = await readDeployments();
    if (active.deploymentId !== oldPin.deploymentId || active.versionId !== oldPin.versionId) {
      throw new RunnerAbort('active_deployment_drift', { active, pin: oldPin });
    }
    const latest = await readVersions();
    if (latest.newestId !== oldPin.versionId) {
      throw new RunnerAbort('latest_upload_drift', { newest: latest.newestId, pinnedActive: oldPin.versionId });
    }
    checkSettings(await readFullSettings());
    log('initial guards passed (active===pin, latest===pin, full safe settings)');
    return active;
  }

  // --- staged upload (inactive version) --------------------------------------
  function buildStagedMetadata() {
    // Verify the pinned payload metadata integrity first: the payload's
    // metadata_sha256 must match the actual pinned metadata JSON bytes.
    if (sha256(Buffer.from(JSON.stringify(payload.metadata))) !== payload.metadata_sha256) {
      throw new RunnerAbort('metadata_pin_drift', { metadata_sha256: payload.metadata_sha256 });
    }
    const meta = payload.metadata;
    // The pinned payload metadata is the OLD PUT-era pin (it contains
    // script-level settings fields as preservation pins). Those fields are
    // NEVER sent here — the staged upload is built as a strict SUBSET.
    if (typeof meta.main_module !== 'string' || meta.main_module.length === 0) {
      throw new RunnerAbort('metadata_missing_main_module');
    }
    if (typeof meta.compatibility_date !== 'string' || !Array.isArray(meta.compatibility_flags)) {
      throw new RunnerAbort('metadata_missing_script_fields');
    }
    if (!Array.isArray(meta.bindings) || meta.bindings.length === 0) {
      throw new RunnerAbort('metadata_missing_bindings');
    }
    for (const b of meta.bindings) {
      if (JSON.stringify(Object.keys(b).sort()) !== JSON.stringify(['name', 'type']) || b.type !== 'inherit') {
        throw new RunnerAbort('binding_not_inherit', { binding: b });
      }
    }
    const out = {
      main_module: meta.main_module,
      compatibility_date: meta.compatibility_date,
      compatibility_flags: JSON.parse(JSON.stringify(meta.compatibility_flags)),
      bindings: meta.bindings.map((b) => ({ type: 'inherit', name: b.name })),
    };
    for (const key of Object.keys(out)) {
      if (!METADATA_SENT_KEYS.has(key)) throw new RunnerAbort('metadata_key_not_allowed', { key });
    }
    return out;
  }

  function buildParts() {
    return payload.parts.map((p) => {
      const bytes = readFile(join(repoRoot, p.path));
      if (payload.part_sha256[p.filename] !== sha256(bytes)) {
        throw new RunnerAbort('part_byte_drift', { part: p.filename, pinned: payload.part_sha256[p.filename], actual: sha256(bytes) });
      }
      return { filename: p.filename, contentType: p.content_type, bytes };
    });
  }

  function stagedActivationBody() {
    return { strategy: 'percentage', versions: [{ version_id: state.ownVersionId, percentage: 100 }], force: false };
  }

  function rollbackBody() {
    return { strategy: 'percentage', versions: [{ version_id: oldPin.versionId, percentage: 100 }], force: false };
  }

  function receiptContent(uploadMetadataHash) {
    const hashes = {};
    for (const p of payload.parts) hashes[p.filename] = payload.part_sha256[p.filename];
    return {
      schema: 'unfancy-recovery-staged-receipt/v1',
      value_free: true,
      account,
      worker,
      mode: 'apply',
      old_deployment_id: oldPin.deploymentId,
      old_version_id: oldPin.versionId,
      own_version_id: state.ownVersionId,
      payload_sha256: {
        deploy: sha256(Buffer.from(JSON.stringify(payload))),
        rollback: sha256(Buffer.from(JSON.stringify(rollbackPayload))),
      },
      source_sha256: hashes,
      pinned_metadata_sha256: payload.metadata_sha256,
      upload_metadata_sha256: uploadMetadataHash,
      activation_body: stagedActivationBody(),
      rollback_body: rollbackBody(),
    };
  }

  function writeReceiptBeforeActivation(uploadMetadataHash) {
    const filename = `${worker}-${state.ownVersionId}.json`;
    const receiptPath = join(receiptDir, filename);
    writeReceipt(receiptPath, receiptContent(uploadMetadataHash));
    state.receiptPath = receiptPath;
    log(`receipt written (value-free, 0600, O_EXCL|O_NOFOLLOW): ${filename}`);
  }

  // POST the staged version. On any unclear outcome: exactly ONE readback
  // (versions list), no retry, no blind repeat.
  async function uploadStaged() {
    // Fresh drift check immediately before this write.
    await initialGuards();

    const metadata = buildStagedMetadata();
    const parts = buildParts();
    const metadataJson = JSON.stringify(metadata);
    const uploadMetadataHash = sha256(Buffer.from(metadataJson));
    const { body, contentType } = buildMultipartBody(metadataJson, parts);

    let res;
    try {
      res = await request('POST', uploadUrl, {
        headers: { 'Content-Type': contentType },
        body,
        logNote: `staged version upload ${worker} (bytes sha256-pinned, body never logged)`,
      });
    } catch (err) {
      // Unknown upload outcome: one readback to classify.
      const latest = await readVersions();
      if (latest.newestId === oldPin.versionId) {
        throw new RunnerAbort('staged_upload_failed_unchanged', { detail: String(err?.message ?? err) });
      }
      throw new RunnerAbort('staged_upload_outcome_unverified', { detail: String(err?.message ?? err) });
    }
    if (res.status !== 200 || !res.json?.success) {
      let latest;
      try {
        latest = await readVersions();
      } catch (e) {
        throw new RunnerAbort('staged_upload_rejected_and_readback_failed', { status: res.status, apiErrors: res.json?.errors });
      }
      if (latest.newestId === oldPin.versionId) {
        throw new RunnerAbort('staged_upload_failed_unchanged', { status: res.status, apiErrors: res.json?.errors });
      }
      throw new RunnerAbort('staged_upload_outcome_unverified', { status: res.status, newest: latest.newestId });
    }
    const id = res.json?.result?.id;
    if (!isUuid(id)) {
      // The legacy PUT returned the script name here. A non-UUID id means the
      // staged version identity is unprovable — NO activation.
      throw new RunnerAbort('staged_version_invalid_id', { id: typeof id === 'string' ? id : String(id) });
    }
    state.ownVersionId = id;
    state.stagedUpload = true;
    writeReceiptBeforeActivation(uploadMetadataHash);
    log(`staged upload accepted; own version ${id} (INACTIVE — not deployed)`);
    return id;
  }

  // --- activation ------------------------------------------------------------
  // Guards freshly before the write: old active UNCHANGED, new latest === own,
  // full safe settings unchanged (script-level settings are never sent).
  async function activate() {
    if (!state.ownVersionId || !state.stagedUpload) throw new RunnerAbort('activate_without_staged_upload');
    if (!state.receiptPath) throw new RunnerAbort('activate_without_receipt');

    const active = await readDeployments();
    if (active.deploymentId !== oldPin.deploymentId || active.versionId !== oldPin.versionId) {
      if (active.versionId === state.ownVersionId) {
        throw new RunnerAbort('own_version_already_active', { active });
      }
      throw new RunnerAbort('pre_activation_active_drift', { active, expected: oldPin });
    }
    const latest = await readVersions();
    if (latest.newestId !== state.ownVersionId) {
      throw new RunnerAbort('pre_activation_latest_drift', { newest: latest.newestId, own: state.ownVersionId });
    }
    checkSettings(await readFullSettings());
    log('pre-activation guards passed (old active unchanged, latest === own, settings unchanged)');

    let res;
    try {
      res = await request('POST', activateUrl, {
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(stagedActivationBody())),
        logNote: `activate own version ${state.ownVersionId} @100% (force:false)`,
      });
    } catch (err) {
      // Unknown activation outcome: exactly one deployments readback.
      return await classifyActivationOutcome(String(err?.message ?? err));
    }
    if (res.status !== 200 || !res.json?.success) {
      return await classifyActivationOutcome(null, { status: res.status, apiErrors: res.json?.errors });
    }
    return await postActivationVerify();
  }

  // One readback classifies an unclear activation. NEVER a retry, NEVER a
  // second activation POST, and never a false success.
  async function classifyActivationOutcome(detail, rejected = {}) {
    let active;
    try {
      active = await readDeployments();
    } catch (e) {
      throw new RunnerAbort('activation_outcome_unverified', { detail, ...rejected, readback: 'failed' });
    }
    if (active.versionId === state.ownVersionId && active.deploymentId !== undefined) {
      state.activated = true;
      return await postActivationVerify({ classified_success: true });
    }
    if (active.versionId === oldPin.versionId) {
      throw new RunnerAbort('activation_failed_unchanged', { detail, ...rejected });
    }
    throw new RunnerAbort('activation_outcome_unverified', { detail, ...rejected, active });
  }

  async function postActivationVerify(extra = {}) {
    const active = await readDeployments();
    if (active.versionId !== state.ownVersionId) {
      if (active.versionId === oldPin.versionId) {
        throw new RunnerAbort('post_activation_old_pin_still_active', { active });
      }
      throw new RunnerAbort('post_activation_foreign_deployment', { active, ownVersion: state.ownVersionId });
    }
    checkSettings(await readFullSettings());
    state.activated = true;
    log(`activation verified: own version ${state.ownVersionId} active at 100%${extra.classified_success ? ' (outcome classified by readback)' : ''}`);
    return active;
  }

  // --- guarded rollback -------------------------------------------------------
  // Guards: own version must be active; foreign version -> STOP; old pin
  // active -> SKIP (noop); old UUID must still exist in the versions LIST
  // (no versions-detail read). force stays false.
  async function rollback() {
    const active = await readDeployments();
    if (active.versionId === oldPin.versionId) {
      log('rollback SKIPPED: old pin is active again — nothing to roll back');
      return { skipped: true, reason: 'old_pin_still_active' };
    }
    if (active.versionId !== state.ownVersionId) {
      throw new RunnerAbort('rollback_foreign_deployment', { active, ownVersion: state.ownVersionId });
    }
    const versions = await readVersions();
    if (!versions.list.some((v) => v.id === oldPin.versionId)) {
      throw new RunnerAbort('rollback_old_version_gone', { oldVersion: oldPin.versionId });
    }
    let res;
    try {
      res = await request('POST', activateUrl, {
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(rollbackBody())),
        logNote: `rollback ${worker} -> pinned old version ${oldPin.versionId} @100% (force:false)`,
      });
    } catch (err) {
      // Unknown rollback outcome: one deployments readback; if the old pin is
      // active the rollback took effect, otherwise STOP truthfully.
      let after;
      try {
        after = await readDeployments();
      } catch (e) {
        throw new RunnerAbort('rollback_outcome_unverified', { detail: String(err?.message ?? err) });
      }
      if (after.versionId === oldPin.versionId) return { skipped: false, verified: true };
      throw new RunnerAbort('rollback_outcome_unverified', { detail: String(err?.message ?? err), after });
    }
    if (res.status !== 200 || !res.json?.success) {
      throw new RunnerAbort('rollback_rejected', { status: res.status, apiErrors: res.json?.errors });
    }
    const after = await readDeployments();
    if (after.versionId !== oldPin.versionId) {
      throw new RunnerAbort('rollback_readback_mismatch', { after });
    }
    log(`rollback verified: old version ${oldPin.versionId} active again`);
    return { skipped: false, verified: true };
  }

  // --- smoke ------------------------------------------------------------------
  async function runSmoke(phase) {
    if (!smoke) throw new RunnerAbort('smoke_callback_required', { phase });
    await smoke({ phase, worker, ownVersionId: state.ownVersionId, oldVersionId: oldPin.versionId });
    log(`smoke passed (phase=${phase})`);
  }

  async function runApply() {
    await initialGuards();
    await uploadStaged();
    try {
      await activate();
      await runSmoke('after-activation');
      return {
        applied: true,
        versionId: state.ownVersionId,
        receipt: state.receiptPath,
        stagedThenActivated: true,
      };
    } catch (err) {
      if (state.activated) {
        // Activation (or smoke) failed after a verified activation: guarded
        // rollback, old readback, smoke against the old version.
        log(`apply failed after activation (${err.reason ?? err.message}) — running guarded rollback`);
        const rb = await rollback();
        try {
          await runSmoke('after-rollback');
        } catch (smokeErr) {
          throw new RunnerAbort('rollback_smoke_failed', { rollback: rb, detail: String(smokeErr?.message ?? smokeErr) });
        }
      } else if (state.stagedUpload) {
        // Staged but never activated: nothing to roll back — the inactive
        // version stays uploaded. This is stated honestly, not hidden.
        log('aborted after staged upload, before activation — the staged version remains INACTIVE (no rollback needed)');
      }
      throw err;
    }
  }

  // --- standalone rollback mode -----------------------------------------------
  // Verifies OWNERSHIP of the own UUID before touching anything: complete
  // single-version-100% distribution with own active, latest === own, old UUID
  // still present in the versions LIST. Old already active -> NOOP. Foreign or
  // mixed -> STOP. force:false always.
  async function standaloneRollback(ownVersionId) {
    if (!isUuid(ownVersionId)) throw new RunnerAbort('rollback_requires_own_uuid', { ownVersionId });
    const active = await readDeployments();
    if (active.versionId === oldPin.versionId) {
      log('standalone rollback NOOP: old pin is already active');
      return { noop: true, reason: 'old_already_active' };
    }
    if (active.versionId !== ownVersionId) {
      throw new RunnerAbort('rollback_foreign_deployment', { active, ownVersionId });
    }
    const versions = await readVersions();
    if (versions.newestId !== ownVersionId) {
      throw new RunnerAbort('rollback_latest_drift', { newest: versions.newestId, ownVersionId });
    }
    if (!versions.list.some((v) => v.id === oldPin.versionId)) {
      throw new RunnerAbort('rollback_old_version_gone', { oldVersion: oldPin.versionId });
    }
    let res;
    try {
      res = await request('POST', activateUrl, {
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(rollbackBody())),
        logNote: `standalone rollback ${worker} -> old version ${oldPin.versionId} @100% (force:false)`,
      });
    } catch (err) {
      let after;
      try {
        after = await readDeployments();
      } catch (e) {
        throw new RunnerAbort('rollback_outcome_unverified', { detail: String(err?.message ?? err) });
      }
      if (after.versionId === oldPin.versionId) return { noop: false, verified: true };
      throw new RunnerAbort('rollback_outcome_unverified', { detail: String(err?.message ?? err), after });
    }
    if (res.status !== 200 || !res.json?.success) {
      throw new RunnerAbort('rollback_rejected', { status: res.status, apiErrors: res.json?.errors });
    }
    const after = await readDeployments();
    if (after.versionId !== oldPin.versionId) {
      throw new RunnerAbort('rollback_readback_mismatch', { after });
    }
    return { noop: false, verified: true };
  }

  return {
    initialGuards,
    uploadStaged,
    activate,
    rollback,
    runApply,
    standaloneRollback,
    state,
    allow,
    oldPin,
    buildStagedMetadata,
    buildParts,
    buildMultipartBody,
    stagedActivationBody,
    rollbackBody,
    request,
  };
}

// --- CLI ---------------------------------------------------------------------
// node recovery/staged-runner.mjs <worker>              -> plan-only (default; makes NOTHING)
// node recovery/staged-runner.mjs <worker> --execute    -> apply via staged version API
// node recovery/staged-runner.mjs <worker> --rollback <own-uuid> -> standalone rollback
//
// Bearer: EXCLUSIVELY process.env.CF_API_TOKEN (plus CF_ACCOUNT_ID). No
// 1Password/op variables are read or forwarded; the parent owns provisioning.
// No binding value is ever logged. Receipts are value-free.
const SMOKE_TARGETS = {
  'steam-proxy': {
    base: 'https://steam.api.nirlau.de',
    origin: 'https://nirlau.de',
    steamid: '76561198159661156', // known repo-config SteamID64 (js/utils.js CONFIG.STEAM_ID)
    positive: { path: () => `/currently-playing?steamid=76561198159661156`, expect: 'steam-currently-playing' },
    negative: { path: () => `/currently-playing?steamid=abc`, expectStatus: 400 },
  },
  'riot-proxy': {
    base: 'https://api.nirlau.de',
    origin: 'https://nirlau.de',
    positive: { path: () => `/lol/Nirlau/Lauri/euw`, expect: 'json-object' },
    negative: { path: () => `/lol/Nirlau/Lauri/xx`, expectStatus: 400 },
  },
};

async function cliSmoke(worker) {
  const t = SMOKE_TARGETS[worker];
  const headers = { Origin: t.origin };
  async function get(path) {
    const res = await fetch(`${t.base}${path}`, { headers });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, acao: res.headers.get('access-control-allow-origin') };
  }
  const pos = await get(t.positive.path());
  if (pos.status !== 200 || !pos.json || typeof pos.json !== 'object') {
    throw new Error(`smoke ${worker} positive failed: HTTP ${pos.status} (expected 200 + JSON object)`);
  }
  if (t.positive.expect === 'steam-currently-playing') {
    if (!('game' in pos.json) || !('appid' in pos.json)) {
      throw new Error(`smoke ${worker} positive schema failed: expected {game, appid} keys`);
    }
  }
  const neg = await get(t.negative.path());
  if (neg.status !== t.negative.expectStatus) {
    throw new Error(`smoke ${worker} negative failed: HTTP ${neg.status} (expected ${t.negative.expectStatus})`);
  }
  // CORS check (possible, not fatal if header absent on some paths): the
  // allowlisted origin must be reflected when present.
  if (pos.acao && pos.acao !== t.origin) {
    throw new Error(`smoke ${worker} CORS check failed: ACAO="${pos.acao}" does not reflect ${t.origin}`);
  }
}

export async function main(argv, env = process.env) {
  const [worker, ...rest] = argv;
  if (!STAGED_RUNNERS.includes(worker)) {
    throw new Error(`staged-runner CLI: worker must be one of ${STAGED_RUNNERS.join(', ')} (got: ${String(worker)})`);
  }
  const execute = rest.includes('--execute');
  const rbIdx = rest.indexOf('--rollback');
  if (!execute && rbIdx === -1) {
    console.log(`plan-only (no --execute/--rollback): would run staged apply for ${worker}: guards -> POST versions?bindings_inherit=strict (inactive) -> receipt -> POST deployments {percentage,100,force:false} -> smoke. No requests made.`);
    return { planOnly: true };
  }
  if (execute && rbIdx !== -1) throw new Error('staged-runner CLI: --execute and --rollback are mutually exclusive');
  const account = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!account || !token) throw new Error('staged-runner CLI: CF_ACCOUNT_ID and CF_API_TOKEN must be set (process env only)');

  const payload = JSON.parse(readFileSync(join(REPO_ROOT, 'recovery', 'generated', `${worker}.deploy.json`), 'utf8'));
  const rollbackPayload = JSON.parse(readFileSync(join(REPO_ROOT, 'recovery', 'generated', `${worker}.rollback.json`), 'utf8'));
  const transport = async ({ method, url, headers, body }) => {
    const res = await fetch(url, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      body: body && Buffer.isBuffer(body) ? new Uint8Array(body) : body,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, headers: res.headers };
  };
  const runner = createStagedRunner({ worker, account, payload, rollbackPayload, transport, log: (m) => console.log(m), smoke: () => cliSmoke(worker) });
  if (execute) {
    const out = await runner.runApply();
    console.log(`STAGED APPLY VERIFIED: ${worker} active on own version ${out.versionId}`);
    return out;
  }
  const ownUuid = rest[rbIdx + 1];
  const out = await runner.standaloneRollback(ownUuid);
  console.log(`STAGED ROLLBACK ${out.noop ? 'NOOP' : 'VERIFIED'}: ${worker}`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof RunnerAbort ? `${err.message} ${JSON.stringify(err.detail)}` : err.message);
    process.exit(1);
  });
}
