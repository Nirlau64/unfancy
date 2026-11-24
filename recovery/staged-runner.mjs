// Staged replacement runner for steam-proxy and riot-proxy (versions API).
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
//    guards latest === pinned-active before every write; AFTER the staged
//    upload the same guard runs against the OWN version id instead.
//  - POST /accounts/{account}/workers/scripts/{worker}/versions?bindings_inherit=strict
//    creates a STAGED (inactive) version; response result.id MUST be a UUID.
//    (The legacy PUT returned the script NAME as result.id — that path is frozen;
//    here a non-UUID result.id aborts before any activation.)
//  - Activation: POST .../deployments JSON {strategy:'percentage',
//    versions:[{version_id:UUID, percentage:100}], force:false}.
//
// Safety contract:
//  - Steam/riot ONLY. spotify workers are refused structurally.
//  - Transport is INJECTED: no network access inside this module. The CLI entry
//    takes the bearer token EXCLUSIVELY from process.env.CF_API_TOKEN (never
//    logged, never persisted, never forwarded to child processes; no
//    1Password variables are read or forwarded — the parent owns provisioning).
//  - Endpoint ALLOWLIST: every request must match an allowlisted pattern before
//    I/O, including on error paths. Forbidden reads (versions detail GET,
//    settings GET for spotify) are structurally impossible. No PATCH, no PUT.
//  - Byte pinning: module part bytes are SHA-256-pinned per part in the payload;
//    the pinned full metadata JSON of the payload is re-verified against its
//    metadata_sha256 pin. The STAGED upload metadata is a strict subset built
//    from the pinned values; its own hash goes into the receipt.
//  - Multipart: the module part's form field NAME is the FILENAME.
//  - Receipt BEFORE activation, value-free, O_CREAT|O_EXCL|O_NOFOLLOW mode 0600
//    under recovery/runs/ (gitignored). Standalone rollback REQUIRES such a
//    receipt (verified with O_NOFOLLOW, mode 0600 and full pin/schema/hash
//    validation) — an arbitrary UUID is never accepted as proof of ownership.
//  - Error hygiene: RunnerAbort details and logs contain ONLY internal reasons,
//    allowlisted smoke phase/category enums, HTTP status numbers and validated
//    numeric API error codes — never API messages, response bodies or exception text.
//  - Unknown write outcome: NO retry, NO blind repeat. Exactly one readback
//    classifies the outcome; if still unclear -> STOP 'unverified', reporting
//    the truthful active state — never a false "inactive" claim.
//  - Settings-drift recovery definition: script-level settings are never
//    written by this runner; only the VERSIONED settings of an old version can
//    be repaired by rolling back. Known drift (safe settings / compat date /
//    bindings inventory) is therefore a REASON to roll back and never blocks
//    the rollback. Unknown/unreadable settings state is not classifiable ->
//    safe STOP with the truthful active id, no false success.
//  - Read-check-write without server-side compare-and-swap is NOT atomic. Every
//    guard is re-run freshly immediately before each write, and the post-write
//    readback classifies what actually happened — the guards shrink the race
//    window, they do not close it.
import { readFileSync, openSync, readSync, writeSync, closeSync, fstatSync, mkdirSync, lstatSync, constants as fsConstants } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { projectSettings } from './readback-projection.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STAGED_RUNNERS = ['steam-proxy', 'riot-proxy'];
const RECEIPT_SCHEMA = 'unfancy-recovery-staged-receipt/v1';
const RECEIPT_MAX_BYTES = 1048576;


export class RunnerAbort extends Error {
  constructor(reason, detail = {}) {
    super(`STAGED RUNNER ABORT: ${reason}`);
    this.reason = reason;
    // Provider-controlled keys, binding names and exception strings are not
    // diagnostics. Keep only bounded numeric status/codes on every exit path.
    this.detail = {};
    if (Number.isInteger(detail.status)) this.detail.status = detail.status;
    if (Array.isArray(detail.apiErrorCodes)) {
      this.detail.apiErrorCodes = detail.apiErrorCodes.filter(Number.isSafeInteger);
    }
    if (['after-activation', 'after-rollback'].includes(detail.phase)) this.detail.phase = detail.phase;
    if (['positive_http', 'positive_json', 'positive_schema', 'cors_mismatch', 'negative_http', 'transport_error'].includes(detail.smokeCategory)) {
      this.detail.smokeCategory = detail.smokeCategory;
    }
  }
}

class SmokeCheckError extends Error {
  constructor(category, status) {
    super('Smoke check failed');
    this.category = category;
    this.status = Number.isInteger(status) ? status : undefined;
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function stagedMetadata(payload) {
  if (sha256(Buffer.from(JSON.stringify(payload.metadata))) !== payload.metadata_sha256) {
    throw new RunnerAbort('metadata_pin_drift');
  }
  const meta = payload.metadata;
  if (typeof meta.main_module !== 'string' || !meta.main_module) throw new RunnerAbort('metadata_missing_main_module');
  if (typeof meta.compatibility_date !== 'string' || !Array.isArray(meta.compatibility_flags)) throw new RunnerAbort('metadata_missing_script_fields');
  if (!Array.isArray(meta.bindings) || !meta.bindings.length) throw new RunnerAbort('metadata_missing_bindings');
  for (const binding of meta.bindings) {
    if (JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(['name', 'type']) || binding.type !== 'inherit') {
      throw new RunnerAbort('binding_not_inherit');
    }
  }
  return {
    main_module: meta.main_module,
    compatibility_date: meta.compatibility_date,
    compatibility_flags: [...meta.compatibility_flags],
    bindings: meta.bindings.map(({ name }) => ({ type: 'inherit', name })),
  };
}

export function formatCliError(err) {
  return err instanceof RunnerAbort
    ? `STAGED RUNNER ABORT: ${err.reason} ${JSON.stringify(err.detail)}`
    : 'STAGED RUNNER ABORT: internal_error';
}

function endpointToRegex(pattern) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}(\\?.*)?$`);
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}


// Numeric API error codes only — API message strings and nested objects are
// never copied into details or logs.
function apiErrorCodes(json) {
  const errs = json?.errors;
  if (!Array.isArray(errs)) return [];
  return errs.map((e) => Number(e?.code)).filter((n) => Number.isFinite(n));
}

// Internal failure reason only — exception texts are never propagated.
function failureReason(err) {
  return err instanceof RunnerAbort ? err.reason : 'transport_error';
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
    throw new RunnerAbort('mixed_distribution', { versionCount: Array.isArray(vs) ? vs.length : -1 });
  }
  return { deploymentId: d.id, versionId: vs[0].version_id };
}

// Official versions-list envelope: the FIRST entry is the latest version; each
// entry carries its id and a created_on metadata. No invented sorting schema.
function versionsListInfo(versionsJson) {
  const versions = versionsJson?.result?.items ?? versionsJson?.result;
  if (!Array.isArray(versions) || versions.length === 0) throw new RunnerAbort('unreadable_versions');
  for (const v of versions) {
    if (!v || typeof v !== 'object' || !isUuid(v.id)) throw new RunnerAbort('unreadable_versions');
  }
  return { newestId: versions[0].id, list: versions };
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

// Drift of script-level settings that only the VERSIONED settings of the old
// version can repair — never a reason for this runner to write settings.
const SETTINGS_DRIFT_REASONS = new Set(['safe_settings_drift', 'compat_date_drift', 'bindings_inventory_drift']);
const SETTINGS_UNKNOWN_REASONS = new Set(['unknown_settings_field', 'unknown_classification']);

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
    throw new RunnerAbort('receipt_exists', { kind: st.isSymbolicLink() ? 'symlink' : 'file' });
  } catch (err) {
    if (err instanceof RunnerAbort) throw err;
    if (err.code !== 'ENOENT') throw new RunnerAbort('receipt_unwritable', { code: err.code });
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
      throw new RunnerAbort('receipt_dir_unreadable', { code: err.code });
    }
  }
  if (dirSt.isSymbolicLink()) throw new RunnerAbort('receipt_dir_symlink', {});
  if (!dirSt.isDirectory()) throw new RunnerAbort('receipt_dir_not_dir', {});
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  let fd;
  try {
    fd = openSync(receiptPath, flags, 0o600);
    writeSync(fd, JSON.stringify(content, null, 2) + '\n');
  } catch (err) {
    throw new RunnerAbort('receipt_write_failed', { code: err.code });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return content;
}

// Read and FULLY validate a rollback receipt (CLI --rollback source of truth).
// lstat rejects symlinks up front; the O_RDONLY|O_NOFOLLOW open is defense in
// depth; mode must be exactly 0600. Complete schema: account, worker, old
// deployment/version pins, own UUID, payload/source/metadata hashes — all
// re-verified against the actual payload pins. Any failure is a STOP with
// ZERO network writes (the CLI validates before it ever builds a transport).
export function readStagedReceipt(receiptPath, { worker, account, payload, rollbackPayload }) {
  let st;
  try {
    st = lstatSync(receiptPath);
  } catch (err) {
    throw new RunnerAbort('receipt_refused', { code: err.code });
  }
  if (st.isSymbolicLink()) throw new RunnerAbort('receipt_refused', { reason: 'symlink' });
  if (!st.isFile()) throw new RunnerAbort('receipt_refused', { reason: 'not_a_file' });
  if ((st.mode & 0o777) !== 0o600) throw new RunnerAbort('receipt_invalid', { check: 'mode_not_0600' });
  if (st.size <= 0 || st.size > RECEIPT_MAX_BYTES) throw new RunnerAbort('receipt_refused', { reason: 'size' });
  let fd;
  try {
    fd = openSync(receiptPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    throw new RunnerAbort('receipt_refused', { code: err.code });
  }
  let text;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.ino !== st.ino || opened.dev !== st.dev) {
      throw new RunnerAbort('receipt_invalid');
    }
    const size = opened.size;
    if (size <= 0 || size > RECEIPT_MAX_BYTES) throw new RunnerAbort('receipt_refused', { reason: 'size' });
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, buf, offset, size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    text = buf.subarray(0, offset).toString('utf8');
  } catch (err) {
    if (err instanceof RunnerAbort) throw err;
    throw new RunnerAbort('receipt_refused', { reason: 'read_failed' });
  } finally {
    closeSync(fd);
  }
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new RunnerAbort('receipt_invalid', { check: 'not_json' });
  }
  const oldPin = {
    deploymentId: rollbackPayload.pinned_live_deployment_id,
    versionId: rollbackPayload.pinned_live_version_id,
  };
  const failed = [];
  const expect = (ok, check) => { if (!ok) failed.push(check); };
  expect(receipt?.schema === RECEIPT_SCHEMA, 'schema');
  expect(receipt?.value_free === true, 'value_free');
  expect(receipt?.account === account, 'account');
  expect(receipt?.worker === worker, 'worker');
  expect(isUuid(receipt?.old_deployment_id), 'old_deployment_id');
  expect(receipt?.old_version_id === oldPin.versionId, 'old_version_id');
  expect(isUuid(receipt?.own_version_id), 'own_version_id');
  expect(receipt?.payload_sha256?.deploy === sha256(Buffer.from(JSON.stringify(payload))), 'payload_sha256.deploy');
  expect(receipt?.payload_sha256?.rollback === sha256(Buffer.from(JSON.stringify(rollbackPayload))), 'payload_sha256.rollback');
  const src = receipt?.source_sha256 ?? {};
  for (const p of payload.parts) expect(src?.[p.filename] === payload.part_sha256[p.filename], `source_sha256.${p.filename}`);
  expect(receipt?.pinned_metadata_sha256 === payload.metadata_sha256, 'pinned_metadata_sha256');
  expect(receipt?.upload_metadata_sha256 === sha256(Buffer.from(JSON.stringify(stagedMetadata(payload)))), 'upload_metadata_sha256');
  expect(JSON.stringify(receipt?.activation_body) === JSON.stringify({
    strategy: 'percentage', versions: [{ version_id: receipt?.own_version_id, percentage: 100 }], force: false,
  }), 'activation_body');
  expect(JSON.stringify(receipt?.rollback_body) === JSON.stringify({
    strategy: 'percentage', versions: [{ version_id: oldPin.versionId, percentage: 100 }], force: false,
  }), 'rollback_body');
  if (failed.length > 0) throw new RunnerAbort('receipt_invalid', { failed });
  return receipt;
}

export function createStagedRunner({
  worker,
  account,
  payload, // parsed recovery/generated/<worker>.deploy.json — used ONLY as pin source
  rollbackPayload, // parsed recovery/generated/<worker>.rollback.json — used ONLY as pin source
  transport, // async ({method,url,headers,body}) -> {status, json}
  log = () => {}, // receives SAFE strings only (no bodies, no binding values)
  readFile = (p) => readFileSync(p),
  repoRoot = REPO_ROOT,
  receiptDir = join(REPO_ROOT, 'recovery', 'runs'),
  smoke, // async ({phase}) -> void; phases 'after-activation' | 'after-rollback'
  resumeReceipt = null,
  expectedActiveDeploymentId = null,
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
  if (resumeReceipt !== null) {
    if (worker !== 'steam-proxy'
      || !isUuid(expectedActiveDeploymentId)
      || resumeReceipt.schema !== RECEIPT_SCHEMA
      || resumeReceipt.mode !== 'apply'
      || resumeReceipt.worker !== worker
      || resumeReceipt.account !== account
      || resumeReceipt.old_version_id !== oldPin.versionId
      || !isUuid(resumeReceipt.own_version_id)) {
      throw new RunnerAbort('resume_receipt_invalid');
    }
  } else if (expectedActiveDeploymentId !== null) {
    throw new RunnerAbort('resume_pin_without_receipt');
  }

  // Runtime state of THIS run (shared between apply and rollback paths).
  const state = {
    ownVersionId: null, // staged UUID from the version upload response (or verified receipt)
    receiptPath: null,
    baselineDeploymentId: oldPin.deploymentId,
    stagedUpload: false, // own staged upload confirmed by THIS run
    activationAttempted: false, // activation POST issued — outcome may be UNKNOWN
    activated: false, // own version CONFIRMED active by deployments readback
  };

  function assertAllowed(method, url) {
    const rule = allow.find((r) => r.method === method && r.re.test(url));
    if (!rule) throw new RunnerAbort('endpoint_not_allowed', { method, worker });
    return rule;
  }

  async function request(method, url, opts = {}) {
    assertAllowed(method, url);
    log(`${method} ${url}${opts.logNote ? ' — ' + opts.logNote : ''}`);
    const res = await transport({ method, url, headers: opts.headers ?? {}, body: opts.body });
    log(`  -> ${Number(res?.status)} ${method} ${url}`);
    return res;
  }

  // --- read guards ----------------------------------------------------------
  async function readDeployments() {
    const res = await request('GET', deploymentsUrl, { logNote: 'deployments guard' });
    if (res.status !== 200 || !res.json?.success) {
      throw new RunnerAbort('guard_read_failed', { guard: 'deployments', status: Number(res.status), apiErrorCodes: apiErrorCodes(res.json) });
    }
    return deploymentInfo(res.json);
  }

  async function readVersions() {
    const res = await request('GET', versionsUrl, { logNote: 'versions list guard' });
    if (res.status !== 200 || !res.json?.success) {
      throw new RunnerAbort('guard_read_failed', { guard: 'versions_list', status: Number(res.status), apiErrorCodes: apiErrorCodes(res.json) });
    }
    return versionsListInfo(res.json);
  }

  async function readFullSettings() {
    const res = await request('GET', guardSettings.endpoint.replace('{ACCOUNT_ID}', account), { logNote: 'full safe settings guard (value-free projection)' });
    if (res.status !== 200 || !res.json?.success) {
      throw new RunnerAbort('guard_read_failed', { guard: 'full_settings', status: Number(res.status), apiErrorCodes: apiErrorCodes(res.json) });
    }
    assertNoUnknownRawFields(res.json.result, guardSettings.pinned_classifications);
    return res.json;
  }

  function checkSettings(json) {
    const projected = projectSettings(json);
    if (projected.compatibility_date !== payload.metadata.compatibility_date) {
      throw new RunnerAbort('compat_date_drift', { expected: payload.metadata.compatibility_date });
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

  // Full guard set. Normal apply requires active/latest to equal the historical
  // pin. Receipt-backed resume permits only the receipt's own latest upload and
  // a separately pinned current deployment id; active version/settings remain
  // bound to the same old-version baseline.
  async function initialGuards() {
    const expectedDeploymentId = resumeReceipt ? expectedActiveDeploymentId : oldPin.deploymentId;
    const expectedLatestId = resumeReceipt ? resumeReceipt.own_version_id : oldPin.versionId;
    const active = await readDeployments();
    if (active.deploymentId !== expectedDeploymentId || active.versionId !== oldPin.versionId) {
      throw new RunnerAbort('active_deployment_drift', { active, expectedDeploymentId, pinnedVersion: oldPin.versionId });
    }
    const latest = await readVersions();
    if (latest.newestId !== expectedLatestId) {
      throw new RunnerAbort(resumeReceipt ? 'resume_latest_drift' : 'latest_upload_drift', { newest: latest.newestId, expectedLatestId });
    }
    checkSettings(await readFullSettings());
    state.baselineDeploymentId = active.deploymentId;
    log(`guards passed (active old pin, latest ${resumeReceipt ? 'receipt-owned upload' : 'old pin'}, full safe settings)`);
    return active;
  }

  // --- staged upload (inactive version) --------------------------------------
  function buildStagedMetadata() {
    return stagedMetadata(payload);
  }

  function buildParts() {
    return payload.parts.map((p) => {
      const bytes = readFile(join(repoRoot, p.path));
      if (payload.part_sha256[p.filename] !== sha256(bytes)) {
        throw new RunnerAbort('part_byte_drift', { part: p.filename });
      }
      return { filename: p.filename, contentType: p.content_type, bytes };
    });
  }

  function activationBodyFor(versionId) {
    return { strategy: 'percentage', versions: [{ version_id: versionId, percentage: 100 }], force: false };
  }

  function stagedActivationBody() {
    return activationBodyFor(state.ownVersionId);
  }

  function rollbackBody() {
    return activationBodyFor(oldPin.versionId);
  }

  function receiptContent(uploadMetadataHash) {
    const hashes = {};
    for (const p of payload.parts) hashes[p.filename] = payload.part_sha256[p.filename];
    return {
      schema: RECEIPT_SCHEMA,
      value_free: true,
      account,
      worker,
      mode: 'apply',
      old_deployment_id: state.baselineDeploymentId,
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
    // Fresh drift check immediately before this write (latest must still be
    // the OLD pin — inherit resolves against the latest upload).
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
        throw new RunnerAbort('staged_upload_failed_unchanged', { detail: failureReason(err) });
      }
      throw new RunnerAbort('staged_upload_outcome_unverified', { detail: failureReason(err) });
    }
    if (res.status !== 200 || !res.json?.success) {
      let latest;
      try {
        latest = await readVersions();
      } catch (e) {
        throw new RunnerAbort('staged_upload_rejected_and_readback_failed', { status: Number(res.status), apiErrorCodes: apiErrorCodes(res.json) });
      }
      if (latest.newestId === oldPin.versionId) {
        throw new RunnerAbort('staged_upload_failed_unchanged', { status: Number(res.status), apiErrorCodes: apiErrorCodes(res.json) });
      }
      throw new RunnerAbort('staged_upload_outcome_unverified', { status: Number(res.status) });
    }
    const id = res.json?.result?.id;
    if (!isUuid(id)) {
      // The legacy PUT returned the script name here. A non-UUID id means the
      // staged version identity is unprovable — NO activation.
      throw new RunnerAbort('staged_version_invalid_id', { idKind: typeof id });
    }
    state.ownVersionId = id;
    state.stagedUpload = true;
    writeReceiptBeforeActivation(uploadMetadataHash);
    log(`staged upload accepted; own version ${id} (STAGED, not deployed)`);
    return id;
  }

  // --- activation ------------------------------------------------------------
  // Guards freshly before the write: old active UNCHANGED, new latest === own,
  // full safe settings unchanged (script-level settings are never sent).
  async function activate() {
    if (!state.ownVersionId || !state.stagedUpload) throw new RunnerAbort('activate_without_staged_upload');
    if (!state.receiptPath) throw new RunnerAbort('activate_without_receipt');

    const active = await readDeployments();
    if (active.deploymentId !== state.baselineDeploymentId || active.versionId !== oldPin.versionId) {
      if (active.versionId === state.ownVersionId) {
        throw new RunnerAbort('own_version_already_active', { active });
      }
      throw new RunnerAbort('pre_activation_active_drift', { active, expectedDeploymentId: state.baselineDeploymentId, expectedVersionId: oldPin.versionId });
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
      state.activationAttempted = true;
    } catch (err) {
      state.activationAttempted = true;
      // Unknown activation outcome: exactly one deployments readback.
      return await classifyActivationOutcome(failureReason(err));
    }
    if (res.status !== 200 || !res.json?.success) {
      state.activationAttempted = true;
      return await classifyActivationOutcome(null, { status: Number(res.status), apiErrorCodes: apiErrorCodes(res.json) });
    }
    return await postActivationVerify();
  }

  // One readback classifies an unclear activation. NEVER a retry, NEVER a
  // second activation POST, and never a false success or false inactive.
  async function classifyActivationOutcome(detail, rejected = {}) {
    let active;
    try {
      active = await readDeployments();
    } catch (e) {
      throw new RunnerAbort('activation_outcome_unverified', { detail, ...rejected, readback: 'failed' });
    }
    if (active.versionId === state.ownVersionId) {
      state.activated = true; // own active CONFIRMED before any settings check
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
    state.activated = true; // CONFIRMED before the settings readback
    checkSettings(await readFullSettings());
    log(`activation verified: own version ${state.ownVersionId} active at 100%${extra.classified_success ? ' (outcome classified by readback)' : ''}`);
    return active;
  }

  // --- shared guarded rollback (auto recovery AND standalone mode) -----------
  // ONE consolidated path. Ownership classification first: complete own-100%
  // distribution active (mixed distribution aborts in deploymentInfo), latest
  // === own (foreign latest -> STOP), old UUID still in the versions LIST.
  // Old already active -> NOOP. Known settings drift is a REASON to roll back
  // (script settings are never written; only the old version's versioned
  // settings can repair them) and never blocks. Unknown or unreadable
  // settings state cannot be classified -> safe STOP with the truthful active
  // id. The rollback write treats transport errors AND HTTP/API rejections
  // identically: exactly one classification readback, no retry. After a
  // confirmed old-active readback: full old-state verification (complete 100%
  // distribution) + settings equality + optional old-contract smoke. The old
  // deployment RECORD id is reported but not compared — a rollback POST may
  // legitimately create a new deployment record for the old version.
  async function guardedRollback({ verifySmoke = false, context }) {
    let active;
    try {
      active = await readDeployments();
    } catch (e) {
      if (e instanceof RunnerAbort && e.reason === 'mixed_distribution') throw e;
      throw new RunnerAbort('rollback_state_unreadable', { from: failureReason(e) });
    }
    if (active.versionId === oldPin.versionId) {
      log(`rollback NOOP (${context}): old pin is already active`);
      return { skipped: true, reason: 'old_already_active', active };
    }
    if (active.versionId !== state.ownVersionId) {
      throw new RunnerAbort('rollback_foreign_deployment', { active, ownVersion: state.ownVersionId });
    }
    const versions = await readVersions();
    if (versions.newestId !== state.ownVersionId) {
      // A newer FOREIGN staged version exists — rolling back while it would
      // still be the inherit target is exactly the ambiguity strict cannot
      // protect against. STOP.
      throw new RunnerAbort('rollback_latest_foreign', { newest: versions.newestId, own: state.ownVersionId });
    }
    if (!versions.list.some((v) => v.id === oldPin.versionId)) {
      throw new RunnerAbort('rollback_old_version_gone', { oldVersion: oldPin.versionId });
    }
    // Settings classification BEFORE the write: drift -> proceed (rollback may
    // repair versioned settings); unknown/unreadable -> safe STOP truthful.
    let driftDetected = false;
    try {
      checkSettings(await readFullSettings());
    } catch (e) {
      if (!(e instanceof RunnerAbort)) throw e;
      if (SETTINGS_DRIFT_REASONS.has(e.reason)) {
        driftDetected = true;
        log(`settings drift detected (${e.reason}) — rollback PROCEEDS: script settings are never written, only the old version's versioned settings can repair this`);
      } else if (SETTINGS_UNKNOWN_REASONS.has(e.reason)) {
        throw new RunnerAbort('rollback_settings_unknown', { active, from: e.reason });
      } else {
        throw new RunnerAbort('rollback_settings_unreadable', { active, from: e.reason });
      }
    }

    let res;
    try {
      res = await request('POST', activateUrl, {
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(rollbackBody())),
        logNote: `rollback ${worker} (${context}) -> old version ${oldPin.versionId} @100% (force:false)`,
      });
    } catch (err) {
      return await classifyRollbackOutcome(failureReason(err), verifySmoke, driftDetected);
    }
    // HTTP/API rejection is treated EXACTLY like a transport failure: unknown
    // outcome until classified by exactly one readback. No retry either way.
    if (res.status !== 200 || !res.json?.success) {
      return await classifyRollbackOutcome(null, verifySmoke, driftDetected, { status: Number(res.status), apiErrorCodes: apiErrorCodes(res.json) });
    }
    return await verifyRolledBack({ driftDetected, verifySmoke });
  }

  // One deployments readback classifies an unclear rollback outcome. NEVER a
  // retry and never a false success or false inactive claim.
  async function classifyRollbackOutcome(detail, verifySmoke, driftDetected, rejected = {}) {
    let after;
    try {
      after = await readDeployments();
    } catch (e) {
      throw new RunnerAbort('rollback_outcome_unverified', { detail, ...rejected, readback: 'failed' });
    }
    if (after.versionId === oldPin.versionId) {
      return await verifyRolledBack({ driftDetected, verifySmoke, classified_success: true });
    }
    throw new RunnerAbort('rollback_outcome_unverified', { detail, ...rejected, after });
  }

  async function verifyRolledBack({ driftDetected, verifySmoke, classified_success = false } = {}) {
    // Confirmed old-active readback: full old-state verification.
    const active = await readDeployments();
    if (active.versionId !== oldPin.versionId) {
      throw new RunnerAbort('rollback_readback_mismatch', { after: active });
    }
    try {
      checkSettings(await readFullSettings());
    } catch (e) {
      if (e instanceof RunnerAbort && SETTINGS_DRIFT_REASONS.has(e.reason)) {
        // The old version did NOT repair the drift — those settings are not
        // versioned. Truthful STOP reporting the ACTIVE old state.
        throw new RunnerAbort('rollback_settings_still_drifted', { active, from: e.reason, driftDetectedBefore: driftDetected });
      }
      throw e;
    }
    log(`rollback verified (${classified_success ? 'outcome classified by readback' : 'direct'}): old version ${oldPin.versionId} active, deployment record ${active.deploymentId}, settings equal`);
    if (verifySmoke) await runSmoke('after-rollback');
    return { skipped: false, verified: true, driftDetectedBefore: driftDetected };
  }

  // --- smoke ------------------------------------------------------------------
  async function runSmoke(phase) {
    if (!smoke) throw new RunnerAbort('smoke_callback_required', { phase });
    try {
      await smoke({ phase, worker, ownVersionId: state.ownVersionId, oldVersionId: oldPin.versionId });
    } catch (err) {
      const detail = err instanceof SmokeCheckError
        ? { phase, smokeCategory: err.category, status: err.status }
        : { phase, smokeCategory: 'transport_error' };
      log(`smoke failed (phase=${phase}, category=${detail.smokeCategory}${detail.status === undefined ? '' : `, status=${detail.status}`})`);
      throw new RunnerAbort('smoke_failed', detail);
    }
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
      // Recovery reachability: everything after the activation POST reaches
      // the guarded rollback as soon as the own version is CONFIRMED active.
      // `activationAttempted` covers the still-unknown case — the recovery
      // path then classifies truthfully and never claims "inactive".
      if (state.activated) {
        log(`apply failed after confirmed activation (${err instanceof RunnerAbort ? err.reason : 'unknown'}) — running guarded rollback`);
        const rb = await guardedRollback({ verifySmoke: true, context: 'apply recovery' });
        return { applied: false, rolledBack: true, rollback: rb, cause: err instanceof RunnerAbort ? err.reason : 'unknown' };
      } else if (state.stagedUpload && !state.activationAttempted) {
        // Staged, activation never attempted: the staged version stays
        // INACTIVE — the one case where "inactive" is proven.
        log('aborted after staged upload, before activation — the staged version remains STAGED/INACTIVE (no rollback needed)');
      }
      throw err;
    }
  }

  // --- standalone rollback mode -----------------------------------------------
  // Source of truth is the VERIFIED RECEIPT (CLI --rollback <receipt-path>):
  // readStagedReceipt validates lstat-no-symlink, mode 0600, O_NOFOLLOW open,
  // full schema and all hashes before anything is written. The receipt's own
  // UUID becomes the shared state's own version id — the SAME guardedRollback
  // path as auto recovery, including the mandatory old-contract smoke.
  async function standaloneRollback(ownVersionId) {
    if (!isUuid(ownVersionId)) throw new RunnerAbort('rollback_requires_receipt_uuid', {});
    state.ownVersionId = ownVersionId;
    return guardedRollback({ verifySmoke: true, context: 'standalone' });
  }

  return {
    initialGuards,
    uploadStaged,
    activate,
    rollback: (opts = {}) => guardedRollback({ verifySmoke: true, context: 'manual', ...opts }),
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
// node recovery/staged-runner.mjs <worker>                          -> plan-only (default; makes NOTHING)
// node recovery/staged-runner.mjs <worker> --execute                -> staged apply (guards, staged upload,
//                                                                      receipt, explicit activation, smoke)
// node recovery/staged-runner.mjs <worker> --rollback <receipt.json> -> standalone rollback, source of truth is
//                                                                      the verified value-free receipt
//
// Bearer: EXCLUSIVELY process.env.CF_API_TOKEN (plus CF_ACCOUNT_ID). No
// 1Password/op variables are read or forwarded; the parent owns provisioning.
// No binding value is ever logged. Receipts are value-free. CLI error output
// carries internal reasons and numeric status/codes only — never API message
// strings or exception texts.
const SMOKE_TARGETS = {
  'steam-proxy': {
    base: 'https://steam.api.nirlau.de',
    origin: 'https://nirlau.de',
    steamid: '76561198159661156', // known repo-config SteamID64 (js/utils.js CONFIG.STEAM_ID)
    positive: { path: `/currently-playing?steamid=76561198159661156`, expect: 'steam-currently-playing' },
    negative: { path: `/currently-playing?steamid=abc`, expectStatus: 400 },
  },
  'riot-proxy': {
    base: 'https://api.nirlau.de',
    origin: 'https://nirlau.de',
    positive: { path: `/lol/Nirlau/Lauri/euw`, expect: 'riot-stats' },
    negative: { path: `/lol/Nirlau/Lauri/xx`, expectStatus: 400 },
  },
};

// CLI smoke for one phase. fetch is INJECTABLE so this runs offline in tests.
//  - phase 'after-activation' (new version): positive 200 + exact schema +
//    EXACT ACAO reflection + negative 400.
//  - phase 'after-rollback' (OLD version): positive + exact ACAO only — the
//    negative-400 hardening must not be demanded from an unhardened old stand.
export async function cliSmoke(worker, phase = 'after-activation', fetchImpl = globalThis.fetch) {
  const t = SMOKE_TARGETS[worker];
  if (!t) throw new Error(`cliSmoke: unknown worker ${worker}`);
  const headers = { Origin: t.origin };
  async function get(path) {
    const res = await fetchImpl(`${t.base}${path}`, { headers });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, acao: res.headers.get('access-control-allow-origin') };
  }
  let pos;
  try { pos = await get(t.positive.path); } catch { throw new SmokeCheckError('transport_error'); }
  if (pos.status !== 200) throw new SmokeCheckError('positive_http', pos.status);
  if (!pos.json || typeof pos.json !== 'object' || Array.isArray(pos.json)) throw new SmokeCheckError('positive_json', pos.status);
  if (t.positive.expect === 'steam-currently-playing') {
    if (!('game' in pos.json) || !('appid' in pos.json)) throw new SmokeCheckError('positive_schema', pos.status);
  } else if (t.positive.expect === 'riot-stats') {
    if (!('summonerName' in pos.json) || typeof pos.json.summonerName !== 'string'
      || !('level' in pos.json) || typeof pos.json.level !== 'number'
      || 'error' in pos.json) throw new SmokeCheckError('positive_schema', pos.status);
  }
  if (pos.acao !== t.origin) throw new SmokeCheckError('cors_mismatch', pos.status);
  if (phase !== 'after-activation') return;
  let neg;
  try { neg = await get(t.negative.path); } catch { throw new SmokeCheckError('transport_error'); }
  if (neg.status !== t.negative.expectStatus) throw new SmokeCheckError('negative_http', neg.status);
}

export async function main(argv, env = process.env, { fetchFn = fetch, receiptDir } = {}) {
  const [worker, ...rest] = argv;
  if (!STAGED_RUNNERS.includes(worker)) {
    throw new Error(`staged-runner CLI: worker must be one of ${STAGED_RUNNERS.join(', ')}`);
  }
  const execute = rest.includes('--execute');
  const rbIdx = rest.indexOf('--rollback');
  const resumeIdx = rest.indexOf('--resume');
  const expectedIdx = rest.indexOf('--expected-active-deployment');
  if (resumeIdx !== -1 && !execute) throw new Error('staged-runner CLI: --resume requires --execute');
  if (resumeIdx === -1 && expectedIdx !== -1) throw new Error('staged-runner CLI: active-deployment pin requires --resume');
  if (resumeIdx !== -1 && rbIdx !== -1) throw new Error('staged-runner CLI: --resume and --rollback are mutually exclusive');
  if (!execute && rbIdx === -1) {
    console.log(`plan-only (no --execute/--rollback): would run staged apply for ${worker}: guards -> POST versions?bindings_inherit=strict (staged) -> receipt -> POST deployments {percentage,100,force:false} -> smoke. No requests made.`);
    return { planOnly: true };
  }
  if (execute && rbIdx !== -1) throw new Error('staged-runner CLI: --execute and --rollback are mutually exclusive');
  const account = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!account || !token) throw new Error('staged-runner CLI: CF_ACCOUNT_ID and CF_API_TOKEN must be set (process env only)');

  const payload = JSON.parse(readFileSync(join(REPO_ROOT, 'recovery', 'generated', `${worker}.deploy.json`), 'utf8'));
  const rollbackPayload = JSON.parse(readFileSync(join(REPO_ROOT, 'recovery', 'generated', `${worker}.rollback.json`), 'utf8'));

  let receipt = null;
  let receiptPath = null;
  let resumeReceipt = null;
  let expectedActiveDeploymentId = null;
  if (rbIdx !== -1 || resumeIdx !== -1) {
    const idx = resumeIdx !== -1 ? resumeIdx : rbIdx;
    receiptPath = rest[idx + 1];
    if (!receiptPath || receiptPath.startsWith('--') || !isAbsolute(receiptPath)) {
      throw new Error(`staged-runner CLI: --${resumeIdx !== -1 ? 'resume' : 'rollback'} requires an absolute receipt path`);
    }
    // Receipt FIRST: full validation with ZERO writes before anything else.
    // A resume requires both proof of the previous upload and an exact active
    // deployment-id pin freshly obtained from a separate read-only preflight.
    receipt = readStagedReceipt(receiptPath, { worker, account, payload, rollbackPayload });
    if (resumeIdx !== -1) {
      if (worker !== 'steam-proxy') throw new RunnerAbort('resume_worker_not_in_scope');
      if (expectedIdx === -1 || !rest[expectedIdx + 1] || !isUuid(rest[expectedIdx + 1])) {
        throw new Error('staged-runner CLI: --resume requires --expected-active-deployment <uuid>');
      }
      resumeReceipt = receipt;
      expectedActiveDeploymentId = rest[expectedIdx + 1];
    }
  }

  const transport = async ({ method, url, headers, body }) => {
    const res = await fetchFn(url, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      body: body && Buffer.isBuffer(body) ? new Uint8Array(body) : body,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json };
  };
  const runner = createStagedRunner({
    worker, account, payload, rollbackPayload, transport,
    log: (m) => console.log(m),
    smoke: ({ phase }) => cliSmoke(worker, phase, fetchFn),
    receiptDir: receiptPath ? dirname(receiptPath) : receiptDir,
    resumeReceipt,
    expectedActiveDeploymentId,
  });
  if (execute) {
    const out = await runner.runApply();
    console.log(`STAGED APPLY ${out.rolledBack ? `ROLLED BACK (cause: ${out.cause})` : 'VERIFIED'}: ${worker}`);
    if (!out.applied) throw new RunnerAbort('apply_failed_recovered');
    return out;
  }
  const out = await runner.standaloneRollback(receipt.own_version_id);
  console.log(`STAGED ROLLBACK ${out.skipped ? 'NOOP' : 'VERIFIED'}: ${worker}`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(formatCliError(err));
    process.exit(1);
  });
}
