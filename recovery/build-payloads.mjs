// Deterministic builder for recovery deploy/rollback payloads (NO network, NO CF calls).
// Regenerate the repo copy with: node recovery/build-payloads.mjs
// Programmatic use: import { buildPayloads } from './build-payloads.mjs';
//   buildPayloads({ outDir: <dir> }) writes 8 JSON files into <dir> and returns their bytes;
//   it NEVER touches the repo directory. Byte-for-byte comparison is the caller's job (see
//   tests/recovery-payloads.test.mjs — drift FAILS, it is never overwritten silently).
//
// Live version pins and safe-settings pins come from the read-only discovery snapshot
// (2026-11-24, .hermes/kanban/workspaces/t_52cfcf3b/restore-snapshot-2026-11-24/discovery-summary.json).
// They are HISTORICAL. Every runner run must re-verify against live state via the guards
// encoded below; a stale pin means: regenerate from a fresh read-only snapshot, never apply blindly.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PIN_COMMIT = '6dcdd25';

// ---------------------------------------------------------------------------
// Safe-settings pins, per worker, straight from the redacted discovery snapshot.
// Every field carries an explicit classification: "preserve" (send identical),
// "absent" (field absent in live settings; omit from payload), "n.a." (response-only,
// never sendable). NO defaults: an unknown live field aborts the run.
// ---------------------------------------------------------------------------
const OBSERVABILITY_RIOT_STEAM = {
  enabled: true,
  head_sampling_rate: 1,
  redact_query_string: false,
  logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
  traces: { enabled: false, persist: true, head_sampling_rate: 1 },
};

const SAFE_SETTINGS_PIN = {
  'riot-proxy': {
    settings: {
      compatibility_flags: [],
      tags: [],
      logpush: false,
      tail_consumers: [],
      placement: {},
      usage_model: 'standard',
      observability: OBSERVABILITY_RIOT_STEAM,
    },
    classifications: {
      compatibility_date: 'preserve', compatibility_flags: 'preserve', tags: 'preserve', logpush: 'preserve',
      tail_consumers: 'preserve', placement: 'preserve', usage_model: 'preserve',
      observability: 'preserve',
      // server-side response metadata: never sendable
      annotations: 'n.a.', cache_options: 'n.a.', limits: 'n.a.', exports: 'n.a.',
      exports_reconciliation: 'n.a.',
    },
    // Live bindings from snapshot: RIOT_API_KEY is secret_text -> settings GET allowed.
    live_bindings_inventory: [{ name: 'RIOT_API_KEY', type: 'secret_text' }],
  },
  'steam-proxy': {
    settings: {
      compatibility_flags: [],
      tags: [],
      logpush: false,
      tail_consumers: [],
      placement: {},
      usage_model: 'standard',
      observability: OBSERVABILITY_RIOT_STEAM,
    },
    classifications: {
      compatibility_date: 'preserve', compatibility_flags: 'preserve', tags: 'preserve', logpush: 'preserve',
      tail_consumers: 'preserve', placement: 'preserve', usage_model: 'preserve',
      observability: 'preserve',
      annotations: 'n.a.', cache_options: 'n.a.', limits: 'n.a.', exports: 'n.a.',
      exports_reconciliation: 'n.a.',
    },
    live_bindings_inventory: [{ name: 'STEAM_API_KEY', type: 'secret_text' }],
  },
  'spotify-proxy': {
    settings: {
      compatibility_flags: [],
      tags: [],
      logpush: false,
      tail_consumers: [],
      placement: {},
      usage_model: 'standard',
      // observability key is ABSENT in the live settings snapshot -> omitted, never defaulted
    },
    classifications: {
      compatibility_date: 'preserve', compatibility_flags: 'preserve', tags: 'preserve', logpush: 'preserve',
      tail_consumers: 'preserve', placement: 'preserve', usage_model: 'preserve',
      observability: 'absent',
      annotations: 'n.a.', cache_options: 'n.a.', limits: 'n.a.', exports: 'n.a.',
      exports_reconciliation: 'n.a.',
    },
    // Forbidden reads: settings GET and GET versions/{id} are FORBIDDEN for this worker
    // (settings can return SPOTIFY_REFRESH_TOKEN plain_text). A prior discovery script DID
    // fetch settings and redacted the output afterwards — the claim is "output redacted
    // after receipt", never "nothing was ever received". No repeat.
    forbidden_reads: ['GET /workers/scripts/spotify-proxy/settings', 'GET /workers/scripts/spotify-proxy/versions/{id}'],
    live_bindings_inventory: null, // pinned from frozen snapshot; live re-read is forbidden
    // Safety note: binding drift on spotify-proxy cannot be re-verified by this runner
    // because the only complete read is forbidden. The strict-inherit PUT (error 10057)
    // is the runtime guard: an unexpected inherit-resolvable binding change fails the upload.
    binding_drift_safety_note:
      'Live binding drift is NOT verifiable (settings GET forbidden). bindings_inherit=strict makes the PUT fail (10057) if any inherit-resolvable binding changed; an unexpected extra live binding is NOT covered by strict-inherit and would be silently replaced by the explicit binding list. Accept only after a separate reviewed decision.',
  },
  'spotify-auth': {
    settings: {
      compatibility_flags: [],
      tags: [],
      logpush: false,
      tail_consumers: [],
      placement: {},
      usage_model: 'standard',
    },
    classifications: {
      compatibility_date: 'preserve', compatibility_flags: 'preserve', tags: 'preserve', logpush: 'preserve',
      tail_consumers: 'preserve', placement: 'preserve', usage_model: 'preserve',
      observability: 'absent',
      annotations: 'n.a.', cache_options: 'n.a.', limits: 'n.a.', exports: 'n.a.',
      exports_reconciliation: 'n.a.',
    },
    live_bindings_inventory: [
      { name: 'SPOTIFY_CLIENT_ID', type: 'secret_text' },
      { name: 'SPOTIFY_CLIENT_SECRET', type: 'secret_text' },
      { name: 'TOKENS', type: 'kv_namespace', namespace_id: '25d14d1f2e2f401fb48facad0d108d66' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Worker table (live pins from the redacted discovery snapshot, 2026-11-24).
// ---------------------------------------------------------------------------
const WORKERS = {
  'spotify-auth': {
    apply_approval: 'NOT_YET_APPROVED',
    apply_blocker:
      'DO class lifecycle: the OAuthState migration is created by this upload, so the version API cannot roll back to a pre-DO old version (DO migration state is not reverted by a version deployment). Auth apply is therefore excluded from the executable runner scope until a separately reviewed rollback story exists. Payload and runtime are checked here; NO supported-rollback claim is made.',
    compatDate: '2021-11-02',
    compatDate_note:
      'Live settings show compatibility_date "" (empty). Per the documented API behaviour (cloudflare/cloudflare-docs, multipart-upload-metadata: "on upload via the API, it defaults to the oldest compatibility date before any flags took effect (2021-11-02)") the live EFFECTIVE date is 2021-11-02. This payload pins that exact effective date explicitly instead of relying on the default; the local miniflare smoke uses the same date.',
    liveBindings: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'TOKENS'],
    liveBindingsTypes: { SPOTIFY_CLIENT_ID: 'secret_text', SPOTIFY_CLIENT_SECRET: 'secret_text', TOKENS: 'kv_namespace' },
    doBinding: { name: 'OAUTH_STATE', class_name: 'OAuthState' },
    // migrations MUST be an OBJECT per the official cloudflare/api-schemas
    // (workers_multiple_step_migrations: tag conditions + "steps" array). It is NOT an array.
    // Earlier migration tag is explicitly pinned ABSENT (discovery settings show no migration
    // fields) — no assumptions about a prior tag.
    migrations: { new_tag: 'unfancy-oauthstate-2026-11-24', steps: [{ new_sqlite_classes: ['OAuthState'] }] },
    live_migration_tag_before: { state: 'absent', evidence: 'discovery settings GET result contains no migrations/migration_tag fields' },
    liveVersionId: 'f9513b3b-1ef4-4a76-ba89-929567392e3c',
    liveDeploymentId: '6cc8eaee-c2f5-498f-906a-f87cfcaaf935',
    parts: ['spotify-auth.js'],
  },
  'spotify-proxy': {
    apply_approval: 'GATED_READ_SCOPE',
    apply_note:
      'Executable payload exists but the runner scope for this worker is read-restricted: no settings GET, no GET versions/{id}, ever (also on error paths). Pre-apply verification relies on deployments list + versions list only.',
    compatDate: '2021-11-02',
    compatDate_note: 'Same documented effective default as spotify-auth; pinned explicitly.',
    liveBindings: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN', 'TOKENS'],
    liveBindingsTypes: {
      SPOTIFY_CLIENT_ID: 'plain_text', SPOTIFY_CLIENT_SECRET: 'secret_text',
      SPOTIFY_REFRESH_TOKEN: 'plain_text', TOKENS: 'kv_namespace',
    },
    doBinding: null,
    migrations: null,
    liveVersionId: 'e42fb0a3-0cc5-40a3-97a6-60570dfd81d5',
    liveDeploymentId: '238219e9-5997-406a-b114-d8ceb951b18f',
    parts: ['spotify-proxy.js', 'invocation-logging.js'],
  },
  'riot-proxy': {
    apply_approval: 'EXECUTABLE',
    compatDate: '2025-10-01',
    liveBindings: ['RIOT_API_KEY'],
    liveBindingsTypes: { RIOT_API_KEY: 'secret_text' },
    doBinding: null,
    migrations: null,
    liveVersionId: '4b7671ad-c908-4dd6-bfa8-777772c39aca',
    liveDeploymentId: '7b0c6e80-8469-48a8-a459-275fb43a7c63',
    parts: ['riot-proxy.js', 'invocation-logging.js'],
  },
  'steam-proxy': {
    apply_approval: 'EXECUTABLE',
    compatDate: '2025-10-03',
    liveBindings: ['STEAM_API_KEY'],
    liveBindingsTypes: { STEAM_API_KEY: 'secret_text' },
    doBinding: null,
    migrations: null,
    liveVersionId: '6e8f4f79-f12c-4fd9-97f0-70da34d54b31',
    liveDeploymentId: '669fc653-539d-4f5f-83ef-3bd2de8c1f28',
    parts: ['steam-proxy.js', 'invocation-logging.js'],
  },
};

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function buildDeployPayload(name, w, partHashes) {
  const safe = SAFE_SETTINGS_PIN[name];
  // Strict inherit: name-only, exact key set {type,name}. Values never leave Cloudflare.
  const bindings = w.liveBindings.map((b) => ({ type: 'inherit', name: b }));
  if (w.doBinding) {
    bindings.push({ type: 'durable_object_namespace', name: w.doBinding.name, class_name: w.doBinding.class_name });
  }
  const metadata = {
    main_module: `${name}.js`,
    bindings,
    // Full safe-settings preservation. Fields classified "absent" are omitted; "n.a."
    // fields are never sent. No defaults for anything else.
    compatibility_date: w.compatDate,
    compatibility_flags: safe.settings.compatibility_flags,
    tags: safe.settings.tags,
    logpush: safe.settings.logpush,
    tail_consumers: safe.settings.tail_consumers,
    placement: safe.settings.placement,
    usage_model: safe.settings.usage_model,
    ...(safe.settings.observability !== undefined ? { observability: safe.settings.observability } : {}),
    ...(w.migrations ? { migrations: w.migrations } : {}),
    annotations: { 'workers/message': `unfancy recovery rollout ${SOURCE_PIN_COMMIT}` },
  };
  return {
    worker: name,
    apply_approval: w.apply_approval,
    ...(w.apply_blocker ? { apply_blocker: w.apply_blocker } : {}),
    ...(w.apply_note ? { apply_note: w.apply_note } : {}),
    method: 'PUT',
    endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/${name}`,
    query: { bindings_inherit: 'strict' },
    // Byte pins: the runner must send EXACTLY these bytes and refuse on any mismatch.
    ...(w.live_migration_tag_before ? { live_migration_tag_before: w.live_migration_tag_before } : {}),
    metadata_sha256: sha256(Buffer.from(JSON.stringify(metadata))),
    part_sha256: partHashes,
    metadata,
    parts: w.parts.map((part) => ({
      filename: part,
      path: `workers/${part}`,
      content_type: 'application/javascript+module',
    })),
    // ---- PRE-APPLY DRIFT GUARDS (separate from post-write guards) ----
    preapply_guards: {
      // Guard 1: the ACTIVE deployment must still be the pinned one...
      active_deployment: {
        method: 'GET',
        endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/${name}/deployments?per_page=1`,
        assert: 'result.deployments[0].id === pinned_live_deployment_id AND its versions[0].version_id === pinned_live_version_id; mismatch -> STOP (stale pin).',
      },
      // Guard 2: inherit resolves to the LATEST UPLOADED version, not the active one.
      // The newest upload MUST equal the pinned active version (no extra unpublished
      // upload), otherwise the PUT inherits from an unexpected version.
      latest_upload: {
        method: 'GET',
        endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/${name}/versions`,
        assert: 'the newest version id in the versions list === pinned_live_version_id AND the total count equals the pinned snapshot count; any extra/unpublished version -> STOP.',
      },
      // Guard 3: full safe settings + bindings inventory (riot/steam only: their bindings
      // are secret_text/kv_namespace, so a settings GET is safe with value-free projection).
      // spotify-proxy: FORBIDDEN read -> guard skipped; see binding_drift_safety_note.
      full_settings: safe.live_bindings_inventory === null
        ? {
            skipped: true,
            reason: 'settings GET is a forbidden read for this worker; only the frozen snapshot inventory is pinned.',
            frozen_bindings_inventory: w.liveBindings.map((b) => ({ name: b, type: w.liveBindingsTypes[b] })),
            binding_drift_safety_note: safe.binding_drift_safety_note,
          }
        : {
            skipped: false,
            method: 'GET',
            endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/${name}/settings`,
            assert: 'projected settings (name/type/resource-id only, readback-projection.mjs) must equal pinned full settings AND the bindings inventory must match live_bindings_inventory exactly; any UNKNOWN field in the live settings result -> STOP (no default handling).',
            pinned_full_settings: safe.settings,
            pinned_classifications: safe.classifications,
            live_bindings_inventory: safe.live_bindings_inventory,
          },
    },
    post_deploy_readback: {
      // Confirm the ACTIVE deployment now references OUR new version (id from the PUT
      // response). A foreign version active after the PUT -> STOP, never auto-rollback.
      method: 'GET',
      endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/${name}/deployments?per_page=1`,
      expected_binding_names_sorted: [...w.liveBindings, ...(w.doBinding ? [w.doBinding.name] : [])].sort(),
      expected_compat_date: w.compatDate,
      expected_full_settings: safe.settings,
      ...(safe.live_bindings_inventory === null
        ? { settings_get: 'FORBIDDEN for this worker (plain_text bindings possible); binding verification is NOT possible — see binding_drift_safety_note' }
        : { settings_get: 'allowed (secret_text/kv_namespace bindings only), value-free projection via readback-projection.mjs' }),
      abort_rule:
        'Active deployment must reference the new version id from the PUT response. If a FOREIGN version is active -> STOP. Settings deviations (riot/steam) -> STOP + rollback payload for this worker.',
    },
    function_smoke: w.doBinding
      ? 'Local miniflare smoke only (tests/oauthstate-miniflare.test.mjs, compatibility_date 2021-11-02 — the same explicit date as this payload). Production /callback needs a live authorized flow by the operator; no secret values handled by this repo.'
      : 'Follow docs/cloudflare-write-plan.md W1 function tests for this worker after operator apply.',
  };
}

function buildRollbackPayload(name, w) {
  const isAuth = name === 'spotify-auth';
  return {
    worker: name,
    // spotify-auth: a version-deployment rollback would target the OLD pre-DO version, but
    // the DO class/migration lifecycle is NOT reversible by version deployment — no supported
    // rollback claim. Auth rollback is out of the executable scope (see apply_blocker).
    rollback_supported: !isAuth,
    ...(isAuth
      ? {
          rollback_note:
            'NOT executable as a supported rollback: rolling the ACTIVE deployment back to this pre-DO version does not remove/revert the OAuthState class or its SQLite migration state, and the DO class lifecycle (created by the unfancy-oauthstate-2026-11-24 migration) blocks a clean version rollback. Any auth rollback needs a separately reviewed procedure. Kept as a payload template only.',
        }
      : {}),
    method: 'POST',
    endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/${name}/deployments`,
    body: {
      strategy: 'percentage',
      versions: [{ version_id: w.liveVersionId, percentage: 100 }],
      annotations: { 'workers/message': `rollback to pinned live version (unfancy recovery, source ${SOURCE_PIN_COMMIT})` },
    },
    pinned_live_deployment_id: w.liveDeploymentId,
    pinned_live_version_id: w.liveVersionId,
    pinned_from: `discovery snapshot 2026-11-24 (source pin ${SOURCE_PIN_COMMIT}); HISTORICAL`,
    // ---- PRE-ROLLBACK GUARDS (separate from the pre-apply guards) ----
    // Applies to the state AFTER an apply: the active deployment must be the NEWLY CREATED
    // own version (recorded at runtime from the PUT response) — never a foreign one, and
    // never still the old pin (that would mean there is nothing to roll back).
    pre_rollback_assert: {
      method: 'GET',
      endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/${name}/deployments?per_page=1`,
      assert:
        "active deployment must reference the NEWLY CREATED own version id (from this run's PUT response). " +
        'Foreign version active -> STOP (intervening foreign deployment). ' +
        'Old pin still active -> SKIP rollback (the PUT never took effect or was reverted; rolling back to the old pin against itself is impossible). ' +
        'Never run this guard against a hard-coded pin; the own version id is runtime state.',
      also_verify_before_apply:
        name === 'spotify-proxy'
          ? 'GET .../versions/{id} is a FORBIDDEN read for this worker; the deployments guard above is the only check.'
          : `GET .../scripts/${name}/versions/${w.liveVersionId} must return 200 (old version still exists).`,
      ...(name === 'spotify-proxy'
        ? { forbidden_reads: SAFE_SETTINGS_PIN[name].forbidden_reads }
        : {}),
    },
    // A FAILED PUT (unchanged state) must NOT roll back: the guard above detects "old pin
    // still active" and skips. Rollback runs only after a verified own-version activation.
    failure_semantics:
      'PUT failed/unchanged -> SKIP rollback (guards detect old pin still active). Unknown PUT outcome -> exactly one deployments readback to classify; still ambiguous -> STOP unverified, no repeat, no blind retry.',
    caveats: [
      ...(name === 'spotify-proxy'
        ? ['SPOTIFY_REFRESH_TOKEN is preserved via type "inherit" only — it is never read, transported or rewritten. bindings_inherit=strict makes the upload fail (error 10057) instead of silently dropping it.']
        : []),
      'Rollback via pinned version deployment does NOT touch secret values.',
    ],
  };
}

export function buildPayloads({ outDir } = {}) {
  const dir = outDir ?? join(REPO_ROOT, 'recovery', 'generated');
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, w] of Object.entries(WORKERS)) {
    const partHashes = Object.fromEntries(
      w.parts.map((p) => [p, sha256(readFileSync(join(REPO_ROOT, 'workers', p)))])
    );
    const deployJson = JSON.stringify(buildDeployPayload(name, w, partHashes), null, 2) + '\n';
    const rollbackJson = JSON.stringify(buildRollbackPayload(name, w), null, 2) + '\n';
    writeFileSync(join(dir, `${name}.deploy.json`), deployJson);
    writeFileSync(join(dir, `${name}.rollback.json`), rollbackJson);
    written.push(
      { file: `${name}.deploy.json`, sha256: sha256(Buffer.from(deployJson)) },
      { file: `${name}.rollback.json`, sha256: sha256(Buffer.from(rollbackJson)) }
    );
  }
  return written;
}

// CLI entry: regenerates the REPO copy (recovery/generated). Tests import buildPayloads()
// with an explicit outDir instead, so a test run can never clobber repo artefacts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const written = buildPayloads();
  const sumLines = written.map((x) => `${x.sha256}  ${x.file}`);
  writeFileSync(join(REPO_ROOT, 'recovery', 'generated', 'SHA256SUMS.txt'), sumLines.join('\n') + '\n');
  console.log('generated', written.length, 'payload files in recovery/generated (+ SHA256SUMS.txt)');
}
