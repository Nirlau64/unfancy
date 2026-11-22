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
