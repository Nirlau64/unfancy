// Executable apply/rollback runner for the recovery payloads (steam + riot priority scope).
//
// Design contract (review findings tm_ad5e01b46cfc):
//  - Node ESM, no dependencies, transport INJECTED: no network access inside this module.
//    The caller supplies `transport({method,url,headers,body}) -> {status, json}`.
//  - The CF bearer token is taken ONLY from process.env.CF_API_TOKEN (CLI entry only) and
//    is passed to the transport exclusively via headers. It is never logged, never written
//    to disk, never forwarded to child processes, and no 1Password env vars are read or
//    forwarded (the parent's resolver owns provisioning).
//  - Endpoint ALLOWLIST: every request must match a payload-specified endpoint pattern.
//    Forbidden reads (e.g. spotify-proxy settings GET, GET versions/{id}) are structurally
//    impossible because they are not on the allowlist — including on error paths.
//  - Raw PUT bodies and any binding values are NEVER logged. Only redacted projections,
//    IDs, methods, URLs and SHA-256 digests are logged.
//  - Pre-apply guards (active deployment pin, latest-upload pin, full safe settings incl.
//    bindings inventory) are separate from the pre-rollback guards (newly created own
//    version active; foreign version -> STOP; old pin still active -> SKIP rollback).
//  - spotify-auth apply_approval is NOT_YET_APPROVED: the runner refuses to apply it.
//  - Byte pinning: the multipart metadata and part bytes are pinned by SHA-256 in the
//    payload; the runner recomputes and refuses to send on any mismatch.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { projectSettings } from './readback-projection.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export class RunnerAbort extends Error {
  constructor(reason, detail = {}) {
    super(`RUNNER ABORT: ${reason}`);
    this.reason = reason;
    this.detail = detail;
  }
}

// --- redaction helpers ------------------------------------------------------
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Endpoint allowlist: patterns come only from the payload. {ACCOUNT_ID} is substituted;
// a URL that does not match the exact allowed pattern is refused before any I/O.
function endpointToRegex(pattern) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?ACCOUNT_ID/g, '[^/]+');
  // Allow an optional query string on any allowed endpoint (e.g. bindings_inherit=strict).
  return new RegExp(`^${esc}(\\?.*)?$`);
}

// Compare projected live settings against the pinned full settings. Unknown fields abort.
function compareSafeSettings(pinned, classifications, liveProjected, log) {
  for (const [key, cls] of Object.entries(classifications)) {
    if (cls === 'n.a.') continue; // response-only, never sent, ignored on readback
    if (cls === 'absent') {
      if (liveProjected[key] !== undefined && liveProjected[key] !== null && liveProjected[key] !== '') {
        throw new RunnerAbort('safe_settings_drift', { field: key, classification: cls, live: typeof liveProjected[key] });
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

// Unknown-field abort must run on the RAW settings result (the projection would silently
// drop unknown fields). Allowed raw keys = classified keys + bindings.
function assertNoUnknownRawFields(rawResult, classifications, log) {
  for (const key of Object.keys(rawResult)) {
    if (key === 'bindings') continue;
    if (!(key in classifications)) {
      throw new RunnerAbort('unknown_settings_field', { field: key });
    }
  }
  return true;
}

function compareBindingInventory(pinnedInventory, liveBindings, log) {
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

// Extract the active deployment's version id from a deployments-list response.
function activeDeploymentInfo(deploymentsJson) {
  const list = deploymentsJson?.result?.deployments;
  if (!Array.isArray(list) || list.length === 0) throw new RunnerAbort('unreadable_deployments');
  const d = list[0];
  const v = d?.versions?.[0]?.version_id;
  if (!v) throw new RunnerAbort('unreadable_deployments');
  return { deploymentId: d.id, versionId: v, deployment: d };
}

export function createRunner({
  worker,
  account,
  payload, // parsed recovery/generated/<worker>.deploy.json
  rollbackPayload, // parsed recovery/generated/<worker>.rollback.json
  transport, // async ({method,url,headers,body}) -> {status, json}
  log = () => {}, // receives SAFE strings only
  readFile = (p) => readFileSync(p), // injectable for tests
  repoRoot = REPO_ROOT,
}) {
  if (!payload || !rollbackPayload || !transport) throw new Error('createRunner: payload, rollbackPayload and transport are required');
  if (payload.apply_approval !== 'EXECUTABLE') {
    throw new RunnerAbort('apply_not_approved', { worker, approval: payload.apply_approval });
  }
  const allow = [];
  for (const g of [payload.preapply_guards.active_deployment, payload.preapply_guards.latest_upload]) {
    allow.push({ re: endpointToRegex(g.endpoint.replace('{ACCOUNT_ID}', account)), method: g.method, kind: 'read' });
  }
  const guardSettings = payload.preapply_guards.full_settings;
  const settingsAllowed = guardSettings && !guardSettings.skipped;
  if (settingsAllowed) allow.push({ re: endpointToRegex(guardSettings.endpoint.replace('{ACCOUNT_ID}', account)), method: 'GET', kind: 'read' });
  allow.push({ re: endpointToRegex(payload.endpoint.replace('{ACCOUNT_ID}', account)), method: 'PUT', kind: 'write' });
  allow.push({ re: endpointToRegex(payload.post_deploy_readback.endpoint.replace('{ACCOUNT_ID}', account)), method: 'GET', kind: 'read' });
  const rollbackEndpoint = rollbackPayload.endpoint.replace('{ACCOUNT_ID}', account);
  allow.push({ re: endpointToRegex(rollbackEndpoint), method: 'POST', kind: 'write' });
  // Old-version existence check before rollback (never present for spotify-proxy).
  const versionExistsUrl = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/versions/${rollbackPayload.pinned_live_version_id}`;
  const versionExistsAllowed = worker !== 'spotify-proxy';
  if (versionExistsAllowed) allow.push({ re: endpointToRegex(versionExistsUrl), method: 'GET', kind: 'read' });

  // Track this run's own state (runtime, not pins).
  const state = { ownNewVersionId: null, applied: false };

  async function request(method, urlPattern, { kind, headers = {}, body, logNote }) {
    const url = typeof urlPattern === 'string' ? urlPattern : urlPattern.url;
    const rule = allow.find((r) => r.method === method && r.re.test(url));
    if (!rule) throw new RunnerAbort('endpoint_not_allowed', { method, url: redactUrl(url), kind: kind ?? 'unknown' });
    log(`${method} ${redactUrl(url)}${logNote ? ' — ' + logNote : ''}`);
    const res = await transport({ method, url, headers, body });
    log(`  -> ${res?.status} ${method} ${redactUrl(url)}${logNote ? ' — ' + logNote : ''}`);
    return res;
  }

  function redactUrl(url) {
    return url;
  }

  // --- reads ---------------------------------------------------------------
  async function readActiveDeployment() {
    const res = await request('GET', payload.preapply_guards.active_deployment.endpoint.replace('{ACCOUNT_ID}', account), { kind: 'read', logNote: 'active deployment guard' });
    if (res.status !== 200 || !res.json?.success) throw new RunnerAbort('guard_read_failed', { guard: 'active_deployment', status: res.status });
    return activeDeploymentInfo(res.json);
  }

  async function readLatestUpload() {
    const base = payload.preapply_guards.latest_upload.endpoint.replace('{ACCOUNT_ID}', account);
    const res = await request('GET', base, { kind: 'read', logNote: 'latest upload guard' });
    if (res.status !== 200 || !res.json?.success) throw new RunnerAbort('guard_read_failed', { guard: 'latest_upload', status: res.status });
    const versions = res.json?.result?.items ?? res.json?.result;
    if (!Array.isArray(versions) || versions.length === 0) throw new RunnerAbort('unreadable_versions');
    // Versions list: newest first per API docs. Sort defensively by creation date string.
    const newest = versions.reduce((a, b) => (String(b.created_on ?? '') > String(a.created_on ?? '') ? b : a));
    return { newestId: newest.id, count: res.json?.result_info?.total_count ?? versions.length };
  }

  async function readFullSettings() {
    const res = await request('GET', guardSettings.endpoint.replace('{ACCOUNT_ID}', account), { kind: 'read', logNote: 'full settings guard (value-free projection)' });
    if (res.status !== 200 || !res.json?.success) throw new RunnerAbort('guard_read_failed', { guard: 'full_settings', status: res.status });
    assertNoUnknownRawFields(res.json.result, guardSettings.pinned_classifications, log);
    return res.json;
  }

  // --- multipart bytes -----------------------------------------------------
  function buildMultipartBytes() {
    const metadataJson = JSON.stringify(payload.metadata);
    if (sha256(Buffer.from(metadataJson)) !== payload.metadata_sha256) {
      throw new RunnerAbort('metadata_byte_drift', { metadata_sha256: payload.metadata_sha256 });
    }
    const parts = payload.parts.map((p) => {
      const bytes = readFile(join(repoRoot, p.path));
      if (payload.part_sha256[p.filename] !== sha256(bytes)) {
        throw new RunnerAbort('part_byte_drift', { part: p.filename, pinned: payload.part_sha256[p.filename], actual: sha256(bytes) });
      }
      return { filename: p.filename, contentType: p.content_type, bytes };
    });
    return { metadataJson, parts };
  }

  function buildMultipartBody({ metadataJson, parts }) {
    const boundary = `unfancy-${sha256(Buffer.from(metadataJson)).slice(0, 24)}`;
    const chunks = [];
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"; filename="metadata"\r\nContent-Type: application/json\r\n\r\n${metadataJson}\r\n`));
    for (const p of parts) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="script"; filename="${p.filename}"\r\nContent-Type: ${p.contentType}\r\n\r\n`));
      chunks.push(p.bytes);
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  // --- main flows ----------------------------------------------------------
  async function preapply() {
    const pin = { deploymentId: rollbackPayload.pinned_live_deployment_id, versionId: rollbackPayload.pinned_live_version_id };
    const active = await readActiveDeployment();
    if (active.deploymentId !== pin.deploymentId || active.versionId !== pin.versionId) {
      throw new RunnerAbort('preapply_active_deployment_drift', { active, pin });
    }
    const latest = await readLatestUpload();
    if (latest.newestId !== pin.versionId) {
      throw new RunnerAbort('preapply_latest_upload_extra', { newest: latest.newestId, pinnedActive: pin.versionId });
    }
    log(`preapply active deployment + latest upload guards passed (${active.deploymentId})`);
    if (settingsAllowed) {
      const json = await readFullSettings();
      const projected = projectSettings(json);
      const pinnedSettings = guardSettings.pinned_full_settings;
      const pinnedCompat = payload.metadata.compatibility_date;
      if (projected.compatibility_date !== pinnedCompat) {
        throw new RunnerAbort('compat_date_drift', { expected: pinnedCompat, live: projected.compatibility_date });
      }
      compareSafeSettings(
        { ...pinnedSettings, compatibility_date: pinnedCompat },
        guardSettings.pinned_classifications,
        { ...projected, compatibility_date: projected.compatibility_date },
        log
      );
      const liveInventory = projected.bindings.map((b) => ({ name: b.name, type: b.type, ...(b.namespace_id ? { namespace_id: b.namespace_id } : {}) }));
      compareBindingInventory(guardSettings.live_bindings_inventory, liveInventory, log);
      log('preapply full settings + bindings inventory guard passed');
    } else {
      log('preapply settings guard SKIPPED (forbidden read) — see binding_drift_safety_note');
    }
  }

  async function apply() {
    const { metadataJson, parts } = buildMultipartBytes();
    const { body, contentType } = buildMultipartBody({ metadataJson, parts });
    const url = payload.endpoint.replace('{ACCOUNT_ID}', account) + '?bindings_inherit=strict';
    let putRes;
    try {
      putRes = await request('PUT', { url }, {
        kind: 'write',
        headers: { 'Content-Type': contentType },
        body,
        logNote: `deploy ${worker} (bytes sha256-pinned, body never logged)`,
      });
    } catch (err) {
      // Unknown PUT outcome: NO repeat. Classify with exactly one deployments readback.
      const active = await readActiveDeployment();
      const pin = rollbackPayload.pinned_live_version_id;
      if (active.versionId === pin) {
        throw new RunnerAbort('put_failed_unchanged', { detail: String(err?.message ?? err) });
      }
      throw new RunnerAbort('put_outcome_unverified', { detail: String(err?.message ?? err) });
    }
    if (putRes.status !== 200 || !putRes.json?.success) {
      // API-rejected PUT: classify with exactly one deployments readback.
      let active;
      try {
        active = await readActiveDeployment();
      } catch (e) {
        throw new RunnerAbort('put_rejected_and_readback_failed', { status: putRes.status, apiErrors: putRes.json?.errors });
      }
      const pin = rollbackPayload.pinned_live_version_id;
      if (active.versionId === pin) {
        throw new RunnerAbort('put_failed_unchanged', { status: putRes.status, apiErrors: putRes.json?.errors });
      }
      throw new RunnerAbort('put_outcome_unverified', { status: putRes.status, active });
    }
    const newVersionId = putRes.json?.result?.id;
    if (!newVersionId) throw new RunnerAbort('put_response_unreadable');
    state.ownNewVersionId = newVersionId;
    state.applied = true;
    log(`apply accepted; own new version ${newVersionId}`);
    return newVersionId;
  }

  async function postApplyVerify() {
    if (!state.ownNewVersionId) throw new RunnerAbort('postverify_without_apply');
    const active = await readActiveDeployment();
    if (active.versionId !== state.ownNewVersionId) {
      if (active.versionId === rollbackPayload.pinned_live_version_id) {
        throw new RunnerAbort('postapply_old_pin_still_active', { active });
      }
      throw new RunnerAbort('postapply_foreign_deployment', { active, ownVersion: state.ownNewVersionId });
    }
    log(`post-apply deployment readback passed (active = own version ${state.ownNewVersionId})`);
    if (settingsAllowed) {
      const json = await readFullSettings();
      const projected = projectSettings(json);
      if (projected.compatibility_date !== payload.metadata.compatibility_date) {
        throw new RunnerAbort('postapply_compat_date_drift', { expected: payload.metadata.compatibility_date, live: projected.compatibility_date });
      }
      compareSafeSettings(
        { ...payload.post_deploy_readback.expected_full_settings, compatibility_date: payload.metadata.compatibility_date },
        guardSettings.pinned_classifications,
        projected,
        log
      );
      const names = projected.bindings.map((b) => b.name).sort();
      if (JSON.stringify(names) !== JSON.stringify(payload.post_deploy_readback.expected_binding_names_sorted)) {
        throw new RunnerAbort('postapply_bindings_drift', { live: names, expected: payload.post_deploy_readback.expected_binding_names_sorted });
      }
      log('post-apply settings readback passed (value-free projection)');
    } else {
      log('post-apply settings readback SKIPPED (forbidden read) — binding verification impossible by scope');
    }
    return active;
  }

  // Rollback: only callable after a verified own-version activation.
  async function rollback() {
    if (!state.ownNewVersionId) throw new RunnerAbort('rollback_without_own_version');
    const active = await readActiveDeployment();
    if (active.versionId !== state.ownNewVersionId) {
      if (active.versionId === rollbackPayload.pinned_live_version_id) {
        log('rollback SKIPPED: old pin is active again — nothing to roll back');
        return { skipped: true, reason: 'old_pin_still_active' };
      }
      throw new RunnerAbort('rollback_foreign_deployment', { active, ownVersion: state.ownNewVersionId });
    }
    // Old version must still exist (forbidden for spotify-proxy by allowlist absence).
    if (worker !== 'spotify-proxy') {
      const res = await request('GET', versionExistsUrl, { kind: 'read', logNote: 'old version still exists' });
      if (res.status !== 200) throw new RunnerAbort('rollback_old_version_gone', { status: res.status });
    }
    const res = await request('POST', rollbackEndpoint, {
      kind: 'write',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(rollbackPayload.body)),
      logNote: `rollback ${worker} -> pinned live version ${rollbackPayload.pinned_live_version_id}`,
    });
    if (res.status !== 200 || !res.json?.success) throw new RunnerAbort('rollback_rejected', { status: res.status, apiErrors: res.json?.errors });
    const after = await readActiveDeployment();
    if (after.versionId !== rollbackPayload.pinned_live_version_id) {
      throw new RunnerAbort('rollback_readback_mismatch', { after });
    }
    log(`rollback verified: active deployment back on pinned live version ${rollbackPayload.pinned_live_version_id}`);
    return { skipped: false, verified: true };
  }

  async function runApply() {
    await preapply();
    await apply();
    try {
      await postApplyVerify();
      return { applied: true, versionId: state.ownNewVersionId, verified: true };
    } catch (err) {
      if (err instanceof RunnerAbort && (err.reason === 'postapply_foreign_deployment' || err.reason === 'postverify_without_apply')) throw err;
      log(`post-apply verification failed (${err.reason ?? err.message}) — running rollback`);
      await rollback();
      throw err;
    }
  }

  return { preapply, apply, postApplyVerify, rollback, runApply, state, allow, request };
}

// CLI entry: node recovery/runner.mjs <worker> --execute
// The bearer is read exclusively from CF_API_TOKEN. No other env source is consulted,
// no op/1Password variables are read or forwarded. `--execute` is required so that a
// bare invocation performs nothing. The parent reviews the exact runner before any
// invocation — this CLI is intentionally silent (prints only its plan) without --execute.
export async function main(argv, env = process.env) {
  const [worker, ...rest] = argv;
  if (!['steam-proxy', 'riot-proxy', 'spotify-proxy'].includes(worker)) {
    throw new Error(`runner CLI: worker must be one of steam-proxy, riot-proxy, spotify-proxy (got: ${String(worker)})`);
  }
  const execute = rest.includes('--execute');
  if (!execute) {
    console.log(`plan-only (no --execute): would apply ${worker} after preapply guards; rollback payload on failure. No requests made.`);
    return { planOnly: true };
  }
  const account = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!account || !token) throw new Error('runner CLI: CF_ACCOUNT_ID and CF_API_TOKEN must be set (process env only)');
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
    return { status: res.status, json };
  };
  const runner = createRunner({ worker, account, payload, rollbackPayload, transport, log: (m) => console.log(m) });
  const out = await runner.runApply();
  console.log(`APPLY VERIFIED: ${worker} active on own version ${out.versionId}`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof RunnerAbort ? `${err.message} ${JSON.stringify(err.detail)}` : err.message);
    process.exit(1);
  });
}
