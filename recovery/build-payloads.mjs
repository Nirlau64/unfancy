// Deterministic builder for recovery deploy/rollback payloads (NO network, NO CF calls).
// Regenerate with: node recovery/build-payloads.mjs
// Live version pins below come from the read-only discovery snapshot
// (2026-11-24, .hermes/kanban/workspaces/t_52cfcf3b/restore-snapshot-2026-11-24/
// discovery-summary.json). They are HISTORICAL: every rollback run must re-read
// GET /accounts/{ACCOUNT_ID}/workers/scripts/{name}/deployments and abort unless
// the active deployment's version_id still matches the pin recorded here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Live state per discovery summary (2026-11-24). compat_date empty -> omit field.
const WORKERS = {
  'spotify-auth': {
    compatDate: null,
    liveBindings: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'TOKENS'],
    doBinding: { name: 'OAUTH_STATE', class_name: 'OAuthState' },
    migrations: [{ new_tag: 'unfancy-oauthstate-2026-11-24', new_sqlite_classes: ['OAuthState'] }],
    liveVersionId: 'f9513b3b-1ef4-4a76-ba89-929567392e3c',
    liveDeploymentId: '6cc8eaee-c2f5-498f-906a-f87cfcaaf935',
    parts: ['spotify-auth.js'],
    rollbackCaveats: [
      'Rollback reverts to the pre-DO KV-state consumer and REMOVES the OAUTH_STATE binding and the OAuthState class: the atomic single-use guarantee is lost.',
      'Do NOT delete/redeploy the OAuthState class afterwards without a separate reviewed removal migration; rollback must be followed by a fresh authorized /setup run.',
    ],
  },
  'spotify-proxy': {
    compatDate: null,
    liveBindings: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN', 'TOKENS'],
    doBinding: null,
    migrations: null,
    liveVersionId: 'e42fb0a3-0cc5-40a3-97a6-60570dfd81d5',
    liveDeploymentId: '238219e9-5997-406a-b114-d8ceb951b18f',
    parts: ['spotify-proxy.js', 'invocation-logging.js'],
    rollbackCaveats: [
      'SPOTIFY_REFRESH_TOKEN is preserved via type "inherit" only — it is never read, transported or rewritten. bindings_inherit=strict makes the upload fail (error 10057) instead of silently dropping it.',
      'Rollback via pinned version deployment does NOT touch bindings or secret values of other versions.',
    ],
  },
  'riot-proxy': {
    compatDate: '2025-10-01',
    liveBindings: ['RIOT_API_KEY'],
    doBinding: null,
    migrations: null,
    liveVersionId: '4b7671ad-c908-4dd6-bfa8-777772c39aca',
    liveDeploymentId: '7b0c6e80-8469-48a8-a459-275fb43a7c63',
    parts: ['riot-proxy.js', 'invocation-logging.js'],
    rollbackCaveats: [],
  },
  'steam-proxy': {
    compatDate: '2025-10-03',
    liveBindings: ['STEAM_API_KEY'],
    doBinding: null,
    migrations: null,
    liveVersionId: '6e8f4f79-f12c-4fd9-97f0-70da34d54b31',
    liveDeploymentId: '669fc653-539d-4f5f-83ef-3bd2de8c1f28',
    parts: ['steam-proxy.js', 'invocation-logging.js'],
    rollbackCaveats: [],
  },
};

const ACCOUNT = { accountId: '{ACCOUNT_ID}' }; // substituted by operator at apply time, never committed

const SOURCE_PIN_COMMIT = '6dcdd25';

function buildDeployPayload(name, w) {
  const metadata = {
    main_module: `${name}.js`,
    bindings: [
      ...w.liveBindings.map((binding) => ({ type: 'inherit', name: binding })),
      ...(w.doBinding
        ? [{ type: 'durable_object_namespace', name: w.doBinding.name, class_name: w.doBinding.class_name }]
        : []),
    ],
    ...(w.compatDate ? { compatibility_date: w.compatDate } : {}),
    ...(w.migrations ? { migrations: w.migrations } : {}),
    annotations: { 'workers/message': `unfancy recovery rollout ${SOURCE_PIN_COMMIT}` },
  };
  return {
    worker: name,
    method: 'PUT',
    endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/${name}`,
    query: { bindings_inherit: 'strict' },
    metadata,
    parts: w.parts.map((part) => ({
      filename: part,
      path: `workers/${part}`,
      content_type: 'application/javascript+module',
    })),
    post_deploy_readback: {
      method: 'GET',
      endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/${name}/settings`,
      expected_binding_names_sorted: [...w.liveBindings, ...(w.doBinding ? [w.doBinding.name] : [])].sort(),
      expected_compat_date: w.compatDate === null ? 'absent-or-empty' : w.compatDate,
      projection: 'readback-projection.mjs (name/type/resource-id only, never values)',
      abort_rule: 'Any deviation (missing/reordered/renamed binding, unexpected type, KV namespace id change, unexpected compatibility_date) -> STOP, run rollback payload for this worker.',
    },
    function_smoke: w.doBinding
      ? 'Local miniflare smoke only (tests/oauthstate-miniflare.test.mjs). Production /callback needs a live authorized flow by the operator; no secret values handled by this repo.'
      : 'Follow docs/cloudflare-write-plan.md W1 function tests for this worker after operator apply.',
  };
}

function buildRollbackPayload(name, w) {
  return {
    worker: name,
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
    pre_rollback_assert: {
      method: 'GET',
      endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/${name}/deployments?per_page=1`,
      assert: 'latest deployment id === pinned_live_deployment_id AND its version_id === pinned_live_version_id; otherwise the pin is stale -> regenerate payloads from a fresh read-only snapshot, never apply blindly.',
      also_verify_before_apply: 'GET .../scripts/{name}/versions/{pinned_live_version_id} must return 200 (version still exists).',
    },
    caveats: w.rollbackCaveats,
  };
}

const outDir = join(root, 'recovery', 'generated');
mkdirSync(outDir, { recursive: true });
for (const [name, w] of Object.entries(WORKERS)) {
  writeFileSync(join(outDir, `${name}.deploy.json`), JSON.stringify(buildDeployPayload(name, w), null, 2) + '\n');
  writeFileSync(join(outDir, `${name}.rollback.json`), JSON.stringify(buildRollbackPayload(name, w), null, 2) + '\n');
}
console.log('generated', Object.keys(WORKERS).length * 2, 'payload files in recovery/generated');
