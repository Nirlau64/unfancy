import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const headersConfig = await readFile(new URL('../_headers', import.meta.url), 'utf8');

function headerValue(name) {
  const line = headersConfig.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith(`${name}: `));
  assert.ok(line, `${name} must be configured in Cloudflare Pages _headers`);
  return line.slice(name.length + 2);
}

test('edge HSTS is set to the approved six-month value only', () => {
  assert.equal(headerValue('Strict-Transport-Security'), 'max-age=15552000');
  assert.doesNotMatch(headersConfig, /includeSubDomains|\bpreload\b/i);
});

test('CSP is report-only and retains the current policy directives', async () => {
  const csp = headerValue('Content-Security-Policy-Report-Only');
  assert.match(csp, /(?:^|;\s*)default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(headersConfig, /^Content-Security-Policy:/m);

  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /http-equiv=["']Content-Security-Policy["']/i,
    'an enforcing CSP meta tag would defeat report-only rollout');
});
