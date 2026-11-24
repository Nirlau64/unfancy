import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Hosting reality (verified live, GitHub deployment 7690910494): nirlau.de is
// served by GitHub Pages from `main`, which does NOT evaluate the `_headers`
// file. The enforcing Content-Security-Policy is therefore the <meta> tag in
// index.html (and the generated route pages) — the Report-Only `_headers`
// entry is only a template for compatible hosts and is never a substitute.
const headersConfig = await readFile(new URL('../_headers', import.meta.url), 'utf8');

function headerValue(name) {
  const line = headersConfig.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith(`${name}: `));
  assert.ok(line, `${name} must be configured in the _headers template`);
  return line.slice(name.length + 2);
}

const ENFORCING_ROUTES = ['index.html', 'steam/index.html', 'spotify/index.html', 'lol/index.html', 'socials/index.html'];

const REQUIRED_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' www.instagram.com",
  "style-src 'self' fonts.googleapis.com 'unsafe-inline'",
  'font-src fonts.gstatic.com',
  "frame-src www.youtube-nocookie.com www.instagram.com",
  'img-src * data:',
  "connect-src 'self' api.nirlau.de spotify.api.nirlau.de steam.api.nirlau.de api.rss2json.com ddragon.leagueoflegends.com static.developer.riotgames.com",
];

// Origins that were verified as no longer required and must not creep back in:
// Chart.js is vendored at /assets/vendor/chart.umd.js (no CDN exception),
// there is no Facebook SDK, and the Instagram embed loader is
// www.instagram.com/embed.js (js/views/socials.js).
const REMOVED_HOSTS = ['cdn.jsdelivr.net', 'connect.facebook.net', 'platform.instagram.com'];

test('_headers template: HSTS is set to the approved six-month value only', () => {
  assert.equal(headerValue('Strict-Transport-Security'), 'max-age=15552000');
  assert.doesNotMatch(headersConfig, /includeSubDomains|\bpreload\b/i);
});

test('enforcing meta CSP is present in the shell and every generated route', async () => {
  for (const file of ENFORCING_ROUTES) {
    const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const meta = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=("([^"]+)"|'([^']+)'|["']([^"']+)["'])/i)
      || html.match(/<meta\s+content=("([^"]+)"|'([^']+)'|["']([^"']+)["'])\s+http-equiv=["']Content-Security-Policy["']/i);
    assert.ok(meta, `${file}: an enforcing CSP meta tag must be present (GitHub Pages serves no edge headers)`);
    const policy = (meta[2] ?? meta[3] ?? meta[4] ?? meta[1]).replace(/;\s*$/, '');
    // sanity: the capture must not stop at an apostrophe inside the policy
    assert.ok(policy.includes(';'), `${file}: meta CSP content was captured incompletely`);
    const directives = policy.split(';').map((d) => d.trim());
    for (const required of REQUIRED_DIRECTIVES) {
      assert.ok(directives.includes(required), `${file}: meta CSP must contain "${required}"`);
    }
    for (const host of REMOVED_HOSTS) {
      assert.ok(!policy.includes(host), `${file}: meta CSP must not re-introduce the unused host "${host}"`);
    }
  }
});

test('_headers Report-Only template stays in sync with the meta policy and never enforces', () => {
  const reportOnly = headerValue('Content-Security-Policy-Report-Only').replace(/;\s*$/, '');
  const directives = reportOnly.split(';').map((d) => d.trim());
  for (const required of REQUIRED_DIRECTIVES) {
    assert.ok(directives.includes(required), `Report-Only template must retain "${required}"`);
  }
  for (const host of REMOVED_HOSTS) {
    assert.ok(!reportOnly.includes(host), `Report-Only template must not carry the unused host "${host}"`);
  }
  assert.doesNotMatch(headersConfig, /^Content-Security-Policy:/m,
    'the template must never contain an enforcing header line (the meta tag is the active policy)');
});
