#!/usr/bin/env node
/**
 * Zero-dependency browser regression for the fragment router.
 *
 * Covers the reported bug: directly loading a static route (/steam/) must not
 * poison the router's 'home' cache with the Steam fragment. Flow:
 *   /steam/ (direct load, service worker active) → click Home → history.back()
 *   → /steam/ → history.forward() → Home. Also checks legacy ?page= routes.
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
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function launchBrowser(binary) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'unfancy-e2e-'));
  const child = spawn(binary, [
    '--headless=new', '--no-first-run', '--disable-gpu', '--no-sandbox',
    `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', 'about:blank',
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

async function evalJs(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text)}`);
  return result.result.value;
}

async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  // Wait until the document is interactive and the router has initialised.
  await evalJs(cdp, `new Promise(resolve => {
    if (document.readyState !== 'loading') return resolve();
    document.addEventListener('DOMContentLoaded', () => resolve());
  })`);
}

function assert(cond, message) {
  if (!cond) throw new Error(`E2E assertion failed: ${message}`);
}

const server = await startServer();
let browser;
try {
  const binaryArg = process.argv.indexOf('--browser');
  const binary = binaryArg !== -1 ? process.argv[binaryArg + 1] : 'google-chrome';
  browser = await launchBrowser(binary);
  // The DevTools ws URL is the browser-level endpoint; page commands need a
  // page target session, so fetch the page's own webSocketDebuggerUrl.
  const debugPort = new URL(browser.wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target exposed by chrome');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 1. Direct load of the static /steam/ route.
  await navigate(cdp, `${ORIGIN}/steam/`);
  await evalJs(cdp, `new Promise(r => setTimeout(r, 400))`);
  assert(await evalJs(cdp, `document.body.dataset.staticPage === 'steam'`), '/steam/ is served as the static steam page');
  assert(await evalJs(cdp, `!!document.querySelector('main #steam')`), '/steam/ shows the Steam fragment');
  assert(await evalJs(cdp, `document.title === 'Unfancy - Steam Statistiken'`), '/steam/ has its own title');

  // 2. Service worker becomes active.
  const swActive = await evalJs(cdp, `(async () => {
    for (let i = 0; i < 40; i++) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.active) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  })()`);
  assert(swActive, 'service worker is active');

  // 3. Navigate to Home via the nav link (clean path in history).
  await evalJs(cdp, `document.querySelector('.nav-link[data-page="home"]').click()`);
  await evalJs(cdp, `new Promise(r => setTimeout(r, 400))`);
  assert(await evalJs(cdp, `location.pathname === '/' && !!document.querySelector('main #home') && !document.querySelector('main #steam')`),
    'Home shows home content on "/" and not the Steam fragment');

  // 4. history.back() → /steam/ with the Steam fragment (the old bug poisoned
  //    the 'home' cache with the Steam fragment; this must never regress).
  await evalJs(cdp, `history.back(); new Promise(r => setTimeout(r, 400))`);
  assert(await evalJs(cdp, `location.pathname === '/steam/'`), 'back returns to /steam/');
  assert(await evalJs(cdp, `!!document.querySelector('main #steam') && !document.querySelector('main #home')`),
    'back/forward shows the Steam fragment, not a poisoned home cache');

  // 5. history.forward() → Home again.
  await evalJs(cdp, `history.forward(); new Promise(r => setTimeout(r, 400))`);
  assert(await evalJs(cdp, `location.pathname === '/' && !!document.querySelector('main #home')`),
    'forward returns to Home with home content');

  // 6. Legacy query route keeps working.
  await navigate(cdp, `${ORIGIN}/?page=spotify`);
  await evalJs(cdp, `new Promise(r => setTimeout(r, 400))`);
  assert(await evalJs(cdp, `!!document.querySelector('main #spotify')`), 'legacy ?page=spotify still renders Spotify');

  console.log('E2E browser regression: all assertions passed');
  cdp.close();
} finally {
  server.close();
  if (browser) {
    browser.child.kill();
    try { rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
  }
}
