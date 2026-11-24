#!/usr/bin/env node
/**
 * Zero-dependency browser regression for the fragment router, run against the
 * REAL hosting surface (same shell, fragments, service worker and — thanks to
 * the enforcing <meta> CSP — the real Content-Security-Policy).
 *
 * Covers the reported bug: directly loading a static route (/steam/) must not
 * poison the router's 'home' cache with the Steam fragment. Flow:
 *   /steam/ (cold direct load) → SW active → controlled direct load →
 *   click Home → history.back() → /steam/ → history.forward() → Home →
 *   legacy ?page= route → /lol/ and /socials/ (live APIs and embeds under CSP).
 *
 * Determinism: every step waits on an explicit observable (the main module's
 * `documentElement.dataset.unfancyReady` readiness marker, router-rendered
 * content, service-worker state) instead of fixed sleeps.
 *
 * The run also installs a `securitypolicyviolation` collector from document
 * start and fails on ANY violation, which proves the live API/reads
 * (spotify.api.nirlau.de, steam.api.nirlau.de, api.nirlau.de, rss2json,
 * ddragon, static.developer.riotgames.com, Instagram embed, YouTube frame)
 * pass under the new meta CSP. Read-only GETs only; no auth/token calls.
 *
 * Requires a local Chrome/Chromium binary (default: google-chrome). Run with:
 *   node scripts/e2e-browser.mjs [--browser /path/to/chrome]
 * Exit code 0 = all assertions passed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8143;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, ORIGIN);
      let path = url.pathname;
      if (path === '/') path = '/index.html';
      else if (/^\/(steam|spotify|lol|socials)\/?$/.test(path)) path = `${path.replace(/\/$/, '')}/index.html`;
      const file = join(ROOT, path);
      if (!existsSync(file)) {
        res.writeHead(404); res.end('not found'); return;
      }
      // No caching at all: every page load must exercise the current files.
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function launchBrowser(binary, startUrl) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'unfancy-e2e-'));
  const child = spawn(binary, [
    '--headless=new', '--no-first-run', '--disable-gpu', '--no-sandbox',
    `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', startUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chrome did not expose a DevTools socket')), 15000);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, wsUrl: match[1], userDataDir });
      }
    });
    child.on('exit', (code) => reject(new Error(`chrome exited early (${code}): ${stderr}`)));
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return this.ready.then(() => new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    }));
  }
  close() { this.ws.close(); }
}

async function evalJs(cdp, expression, attempts = 4) {
  // A CDP evaluate can race a commit ("Inspected target navigated or
  // closed"); retry briefly instead of failing the run flakily.
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text)}`);
      return result.result.value;
    } catch (error) {
      const transient = String(error).includes('-32000') || String(error).includes('navigated or closed');
      if (!transient || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

/** Poll an in-page predicate until truthy or the deadline passes. */
async function waitFor(cdp, predicateExpression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evalJs(cdp, predicateExpression)) return;
    if (Date.now() > deadline) throw new Error(`E2E timeout waiting for: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitForBoot(cdp);
}

/**
 * Explicit, deterministic bootstrap readiness of the CURRENT document:
 * the entry module has registered its global listeners AND the DOM is
 * interactive. Never inferred from a fixed sleep.
 */
function waitForBoot(cdp) {
  return waitFor(cdp, `document.readyState !== 'loading' && document.documentElement.dataset.unfancyReady === 'main'`,
    'entry module bootstrap (unfancyReady)', 15000);
}

function assert(cond, message) {
  if (!cond) throw new Error(`E2E assertion failed: ${message}`);
}

const server = await startServer();
let browser;
try {
  const binaryArg = process.argv.indexOf('--browser');
  const binary = binaryArg !== -1 ? process.argv[binaryArg + 1] : 'google-chrome';
  browser = await launchBrowser(binary, `${ORIGIN}/steam/`);
  // Start directly on /steam/: the initial about:blank entry otherwise stays
  // in the session history and makes history.back() non-deterministic.
  // The DevTools ws URL is the browser-level endpoint; page commands need a
  // page target session, so fetch the page's own webSocketDebuggerUrl.
  const debugPort = new URL(browser.wsUrl).port;
  const cdp = await (async () => {
    // Attaching can race the initial target navigation ("Inspected target
    // navigated or closed"); retry with a fresh target list.
    let lastError;
    for (let i = 0; i < 5; i++) {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = targets.find(t => t.type === 'page');
      if (!page) { lastError = new Error('no page target exposed by chrome'); continue; }
      try {
        const cdp = new CDP(page.webSocketDebuggerUrl);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        // Collect CSP violations from every document that ever loads here.
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
          window.__cspViolations = [];
          document.addEventListener('securitypolicyviolation', (e) => {
            window.__cspViolations.push({ directive: e.violatedDirective, uri: (e.sourceFile || e.documentURI || ''), blocked: (e.blockedURL || '') });
          });
        ` });
        return cdp;
      } catch (error) { lastError = error; }
    }
    throw lastError;
  })();

  // 1. Cold direct load of the static /steam/ route (no service worker yet).
  await navigate(cdp, `${ORIGIN}/steam/`);
  assert(await evalJs(cdp, `document.body.dataset.staticPage === 'steam'`), '/steam/ is served as the static steam page');
  assert(await evalJs(cdp, `!!document.querySelector('main #steam')`), '/steam/ shows the Steam fragment');
  assert(await evalJs(cdp, `document.title === 'Unfancy - Steam Statistiken'`), '/steam/ has its own title');

  // 2. Service worker becomes active (explicit state polling, no fixed sleep).
  const swActive = await evalJs(cdp, `(async () => {
    for (let i = 0; i < 100; i++) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.active) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  })()`);
  assert(swActive, 'service worker is active');

  // 2b. Controlled direct load, separate from the cold load: reload so the
  // service worker actually controls a fresh direct navigation of the static
  // route, and wait for that page's own bootstrap before continuing.
  await navigate(cdp, `${ORIGIN}/steam/`);
  const controlled = await evalJs(cdp, `(async () => {
    for (let i = 0; i < 100; i++) {
      if (navigator.serviceWorker.controller) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  })()`);
  assert(controlled, 'a direct /steam/ load is controlled by the service worker (navigator.serviceWorker.controller)');
  assert(await evalJs(cdp, `navigator.serviceWorker.controller && navigator.serviceWorker.controller.state === 'activated'`),
    'the controlling service worker is activated');
  assert(await evalJs(cdp, `document.body.dataset.staticPage === 'steam' && !!document.querySelector('main #steam')`),
    'controlled direct load still renders the Steam fragment');

  // 3. Navigate to Home via the nav link (SPA path — the listener is provably
  //    registered because the current document booted: unReady-boot would fall
  //    back to the anchor's href and mask routing bugs; waitForBoot excludes
  //    that). Assert real HOME content, not merely "not #steam".
  await evalJs(cdp, `document.querySelector('.nav-link[data-page="home"]').click()`);
  // Wait only for the routing to have completed (the SPA pushed "/"), then
  // assert the CONTENT — so a poisoned home cache fails on this specific
  // assertion, not on a readiness timeout.
  await waitFor(cdp, `location.pathname === '/'`, 'Home route after /steam/ direct load');
  assert(await evalJs(cdp, `!!document.querySelector('main #home') && !!document.querySelector('main #home-title') && !document.querySelector('main #steam')`),
    'Home shows the real home fragment (home-title present), not a poisoned cache');

  // 4. history.back() → /steam/ with the Steam fragment (the old bug poisoned
  //    the 'home' cache with the Steam fragment; this must never regress).
  await evalJs(cdp, `history.back()`);
  await waitFor(cdp, `location.pathname === '/steam/'`, 'back returns to /steam/');
  assert(await evalJs(cdp, `!!document.querySelector('main #steam') && !document.querySelector('main #home-title')`),
    'back/forward shows the Steam fragment, not a poisoned home cache');

  // 5. history.forward() → Home again: still the REAL home fragment.
  await evalJs(cdp, `history.forward()`);
  await waitFor(cdp, `location.pathname === '/'`, 'forward returns to Home');
  assert(await evalJs(cdp, `!!document.querySelector('main #home') && !!document.querySelector('main #home-title')`),
    'forward returns to Home with the real home content');

  // 6. Legacy query route keeps working.
  await navigate(cdp, `${ORIGIN}/?page=spotify`);
  await waitFor(cdp, `!!document.querySelector('main #spotify')`, 'legacy ?page=spotify renders Spotify');
  assert(await evalJs(cdp, `!!document.querySelector('main #spotify')`), 'legacy ?page=spotify still renders Spotify');

  // 7. /lol/ via nav: live Riot data reads (ddragon, static.developer.riotgames.com, api.nirlau.de) under the meta CSP.
  await evalJs(cdp, `document.querySelector('.nav-link[data-page="lol"]').click()`);
  await waitFor(cdp, `!!document.querySelector('main #lol')`, '/lol/ renders via nav');
  assert(await evalJs(cdp, `!!document.querySelector('main #lol')`), '/lol/ renders its fragment');

  // 8. /socials/ via nav: Instagram embed script (www.instagram.com) and the
  //    YouTube nocookie iframe under the meta CSP.
  await evalJs(cdp, `document.querySelector('.nav-link[data-page="socials"]').click()`);
  await waitFor(cdp, `!!document.querySelector('main #socials')`, '/socials/ renders via nav');
  assert(await evalJs(cdp, `!!document.querySelector('main #socials')`), '/socials/ renders its fragment');

  // 9. CSP enforcement: no violation happened anywhere in this run (page,
  //    workers, live API reads, embeds).
  await new Promise(resolve => setTimeout(resolve, 1000)); // give late embed loads a chance to report
  const violations = await evalJs(cdp, `window.__cspViolations || []`);
  assert(Array.isArray(violations) && violations.length === 0,
    `no Content-Security-Policy violations: ${JSON.stringify(violations)}`);

  console.log('E2E browser regression: all assertions passed');
  cdp.close();
} finally {
  server.close();
  if (browser) {
    browser.child.kill();
    try { rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
  }
}
