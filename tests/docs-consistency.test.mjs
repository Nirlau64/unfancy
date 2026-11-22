import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('current pinned workers contain no /refresh-check endpoint or DIAG_TOKEN secret', async () => {
  const proxy = await readFile(new URL('../workers/spotify-proxy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(proxy, /refresh-check/i);
  assert.doesNotMatch(proxy, /DIAG_TOKEN/);
  const auth = await readFile(new URL('../workers/spotify-auth.js', import.meta.url), 'utf8');
  assert.doesNotMatch(auth, /refresh-check/i);
  assert.doesNotMatch(auth, /DIAG_TOKEN/);
});

test('docs no longer describe /refresh-check or DIAG_TOKEN as part of the current source', async () => {
  for (const doc of ['docs/cloudflare-write-plan.md', 'docs/high-impact-hardening.md']) {
    const text = await readFile(new URL(`../${doc}`, import.meta.url), 'utf8');
    const stale = text.split('\n').filter((line) => /\/refresh-check|DIAG_TOKEN/.test(line) && !/berholt|Korrektur|berholt|HISTORISCH|historisch|älteren|aelteren|ießender Quellstand|keinen|kein .*/i.test(line));
    assert.deepEqual(stale, [], `${doc} must mark every /refresh-check/DIAG_TOKEN mention as historical`);
  }
});

test('cloudflare-diff.txt is clearly marked historical with a stated baseline', async () => {
  const diff = await readFile(new URL('../cloudflare-diff.txt', import.meta.url), 'utf8');
  assert.ok(diff.startsWith('# HISTORISCH'), 'diff must open with the historical marker');
  assert.match(diff, /baseline|Baseline|3dcf4b82/);
});

test('every W0 endpoint targets a per-run suffixed probe name (never the unsuffixed name)', async () => {
  const text = await readFile(new URL('../docs/cloudflare-write-plan.md', import.meta.url), 'utf8');
  // No unsuffixed endpoint target at all.
  assert.doesNotMatch(text, /\/workers\/scripts\/unfancy-harden-probe\//,
    'W0 endpoint targets must use the per-run suffixed name, never bare unfancy-harden-probe');
  // Bare (unsuffixed) name occurrences are allowed only in the explicit rule/naming sentences.
  for (const line of text.split('\n')) {
    for (const m of line.match(/unfancy-harden-probe(?!-)/g) || []) {
      assert.match(line, /niemals|Endpoint-Konsistenz|Probe-Namensgebung/,
        `bare probe name outside a rule sentence: ${line.slice(0, 120)}`);
    }
  }
  // Every endpoint-shaped probe reference carries a <suffix>.
  const eps = text.match(/\/workers\/scripts\/unfancy-harden-probe[^ `"]*\/?/g) || [];
  assert.ok(eps.length > 0, 'write-plan references at least one W0 probe endpoint');
  for (const ep of eps) assert.match(ep, /unfancy-harden-probe-(empty-)?<suffix>/, `endpoint without per-run suffix: ${ep}`);
  // The doc must state the endpoint-consistency rule explicitly.
  assert.match(text, /Endpoint-Konsistenz \(W0\)/);
});

test('restore bundles are labelled historical/unverified: doc states ABSENT/request:null and PARTIAL_ONLY and gates writes on exact active bundles/settings', async () => {
  const text = await readFile(new URL('../docs/cloudflare-write-plan.md', import.meta.url), 'utf8');
  // cf-live references must never read as a verified restore bundle.
  for (const line of text.split('\n')) {
    if (/cf-live/.test(line)) {
      assert.match(line, /historisch|unverifiziert|UNVERIFIZIERT|HISTORISCH/,
        `cf-live mention not marked historical/unverified: ${line.slice(0, 120)}`);
    }
  }
  // Doc must state the manifest restore reality and the write gate.
  assert.match(text, /`ABSENT` mit `request:null`/);
  assert.match(text, /`PARTIAL_ONLY` mit `request:null`/);
  assert.match(text, /kein bewiesener Rollback|kein belegter Restore/);
  assert.match(text, /per Read-only-Export erfasst und als reviewed Artifact vorliegen/);
});

