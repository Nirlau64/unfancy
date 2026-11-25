#!/usr/bin/env node
/**
 * Browser smoke regression tests (node:test, zero-dependency CDP).
 *
 * Runs against a REAL locally started static server (no mocks) serving the
 * repository root, exercising the real shell, fragment router, service worker
 * and the enforcing <meta> CSP:
 *
 *   1. Direct routes: every clean route and page fragment resolves; unknown
 *      routes, fragments and assets fail with 404 (fragment/asset errors).
 *   2. Navigation: cold direct load of a deep route must not poison the
 *      router's 'home' cache; in-app navigation and history back/forward
 *      restore the correct view.
 *   3. Offline fallback: once the service worker is active, both a precached
 *      document fetch and a navigation to an unknown document keep working
 *      after the server is shut down (the practical offline check).
 *
 * Determinism: every browser step waits on an explicit observable (the
 * `documentElement.dataset.unfancyReady` marker, per-page document titles,
 * the active nav link, service-worker state) instead of fixed sleeps.
 *
 * Requires a local Chrome/Chromium binary (env CHROME_BIN, default:
 * google-chrome). Run with: node --test tests/e2e/browser-smoke.test.mjs
 * Exit code 0 = all assertions passed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url, 'http://127.0.0.1');
            let path = url.pathname;
            if (path === '/') path = '/index.html';
            else if (/^\/(steam|spotify|lol|socials)\/?$/.test(path)) path = `${path.replace(/\/$/, '')}/index.html`;
            const file = join(ROOT, path);
            if (!existsSync(file)) {
                res.writeHead(404); res.end('not found'); return;
            }
            // No caching at all: every page load must exercise the current files.
            res.writeHead(200, {
                'content-type': MIME[extname(file)] || 'application/octet-stream',
                'cache-control': 'no-store',
                'service-worker-allowed': '/',
            });
            res.end(readFileSync(file));
        });
        server.on('error', reject);
        // Ephemeral port: parallel test runs and CI cannot collide on 8143.
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function findChromeBinary() {
    if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
    for (const candidate of ['google-chrome', 'chromium', 'chromium-browser']) {
        if (spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return candidate;
    }
    throw new Error('no Chrome/Chromium binary found (set CHROME_BIN)');
}

function launchBrowser(binary, startUrl) {
    const userDataDir = mkdtempSync(join(tmpdir(), 'unfancy-smoke-'));
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
        this.events = [];
        this.ready = new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = () => reject(new Error('DevTools WebSocket error'));
        });
        this.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (!msg.id && ['Runtime.exceptionThrown', 'Log.entryAdded', 'Network.loadingFailed'].includes(msg.method)) {
                this.events.push({ method: msg.method, params: msg.params });
                if (this.events.length > 20) this.events.shift();
            }
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
            if (result.exceptionDetails) {
                throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text)}`);
            }
            return result.result.value;
        } catch (error) {
            const transient = String(error).includes('-32000') || String(error).includes('navigated or closed');
            if (!transient || attempt >= attempts) throw error;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
}

/** Poll an in-page predicate until truthy or the deadline passes. */
async function waitFor(cdp, predicateExpression, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await evalJs(cdp, predicateExpression)) return;
        if (Date.now() > deadline) {
            const state = await evalJs(cdp, `({ href: location.href, title: document.title, ready: document.documentElement.dataset.unfancyReady, controller: !!navigator.serviceWorker.controller, cacheKeys: (async () => await caches.keys())() })`).catch(() => null);
            throw new Error(`smoke timeout waiting for: ${label}; state=${JSON.stringify(state)}; browserEvents=${JSON.stringify(cdp.events)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

/** Explicit, deterministic readiness of the CURRENT document. */
function waitForBoot(cdp) {
    return waitFor(cdp,
        `document.readyState !== 'loading' && document.documentElement.dataset.unfancyReady === 'main'`,
        'entry module bootstrap (unfancyReady)');
}

async function navigate(cdp, url) {
    await cdp.send('Page.navigate', { url });
    await waitForBoot(cdp);
}

function assertActivePage(cdp, pageName) {
    return waitFor(cdp,
        `document.querySelector('.nav-tabs .nav-link.active')?.dataset.page === '${pageName}'`,
        `active nav link = ${pageName}`);
}

test('browser smoke against a real local static server', async () => {
    const server = await startServer();
    const port = server.address().port;
    const ORIGIN = `http://127.0.0.1:${port}`;

    await test('direct routes resolve and unknown routes/fragments/assets 404', async () => {
        for (const route of ['/', '/steam/', '/spotify/', '/lol/', '/socials/']) {
            const res = await fetch(`${ORIGIN}${route}`);
            assert.equal(res.status, 200, `route ${route} must resolve`);
            assert.match(res.headers.get('content-type'), /^text\/html/);
        }
        assert.equal((await fetch(`${ORIGIN}/pages/steam.html`)).status, 200, 'steam fragment must resolve');
        assert.equal((await fetch(`${ORIGIN}/pages/home.html`)).status, 200, 'home fragment must resolve');
        assert.equal((await fetch(`${ORIGIN}/definitely-not-a-route/`)).status, 404, 'unknown route must 404');
        assert.equal((await fetch(`${ORIGIN}/pages/missing.html`)).status, 404, 'missing fragment must 404');
        assert.equal((await fetch(`${ORIGIN}/assets/missing.png`)).status, 404, 'missing asset must 404');
    });

    const binary = findChromeBinary();
    // Start directly on /steam/: the initial about:blank entry otherwise stays
    // in the session history and makes history.back() non-deterministic.
    const browser = await launchBrowser(binary, `${ORIGIN}/steam/`);
    let cdp;
    try {
        const debugPort = new URL(browser.wsUrl).port;
        let lastError;
        for (let i = 0; i < 5 && !cdp; i++) {
            const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
            const page = targets.find(t => t.type === 'page');
            if (!page) { lastError = new Error('no page target exposed by chrome'); continue; }
            try {
                cdp = new CDP(page.webSocketDebuggerUrl);
                await cdp.send('Page.enable');
                await cdp.send('Runtime.enable');
                await cdp.send('Log.enable');
                await cdp.send('Network.enable');
            } catch (error) { cdp = undefined; lastError = error; }
        }
        if (!cdp) throw lastError;

        await test('cold direct load of /steam/ renders Steam without poisoning the home cache', async () => {
            await assertActivePage(cdp, 'steam');
            assert.equal(await evalJs(cdp, 'document.title'), 'Unfancy - Steam Statistiken');
            assert.ok(await evalJs(cdp, `!!document.querySelector('#app-content #steam')`), 'steam fragment rendered');
            assert.ok(!(await evalJs(cdp, `!!document.querySelector('#app-content #home-title')`)),
                'home fragment must not leak into a direct /steam/ load');
        });

        await test('in-app navigation home, then history back/forward', async () => {
            await evalJs(cdp, `document.querySelector('.nav-tabs a[data-page="home"]').click()`);
            await assertActivePage(cdp, 'home');
            assert.equal(await evalJs(cdp, 'document.title'), 'Unfancy - Dashboard');
            assert.ok(await evalJs(cdp, `!!document.querySelector('#app-content #home-title')`),
                'home view rendered after clicking Home (no cache poisoning)');
            assert.equal(await evalJs(cdp, 'location.pathname'), '/', 'home pushState uses /');

            await evalJs(cdp, 'history.back()');
            await assertActivePage(cdp, 'steam');
            assert.equal(await evalJs(cdp, 'document.title'), 'Unfancy - Steam Statistiken');
            assert.equal(await evalJs(cdp, 'location.pathname'), '/steam/');

            await evalJs(cdp, 'history.forward()');
            await assertActivePage(cdp, 'home');
            assert.equal(await evalJs(cdp, 'document.title'), 'Unfancy - Dashboard');
        });

        await test('legacy ?page= route still works', async () => {
            await navigate(cdp, `${ORIGIN}/?page=lol`);
            await assertActivePage(cdp, 'lol');
            assert.equal(await evalJs(cdp, 'document.title'), 'Unfancy - League of Legends');
        });

        await test('missing fragment/asset requests fail as 404 while the app stays functional', async () => {
            await navigate(cdp, `${ORIGIN}/`);
            const fragmentStatus = await evalJs(cdp, `fetch('/pages/missing.html').then(r => r.status)`);
            assert.equal(fragmentStatus, 404, 'missing fragment fetch reports 404 in-page');
            const assetStatus = await evalJs(cdp, `fetch('/assets/missing.png').then(r => r.status)`);
            assert.equal(assetStatus, 404, 'missing asset fetch reports 404 in-page');
            assert.equal(await evalJs(cdp, 'document.title'), 'Unfancy - Dashboard',
                'app stays functional after fragment/asset errors');
        });

        await test('offline fallback: service worker serves precached documents with the server down', async () => {
            // Wait until the SW is active AND controlling this document.
            await waitFor(cdp,
                `navigator.serviceWorker.controller !== null`,
                'service worker controlling the page');
            await waitFor(cdp,
                `(async () => (await caches.keys()).some(key => /^unfancy-v\\d+$/.test(key)))()`,
                'service worker cache warmed');

            // Shut the server down: anything served now must come from the SW cache.
            await new Promise(resolve => server.close(resolve));

            const offlineFetch = await evalJs(cdp, `
                fetch('/', { cache: 'reload' })
                    .then(r => r.text().then(t => ({ status: r.status, home: t.includes('Unfancy') })))
            `);
            assert.equal(offlineFetch.status, 200, 'precached / must be served from the SW cache offline');
            assert.equal(offlineFetch.home, true, 'offline / response must be the home document');

            // Navigation fallback: an unknown document offline must fall back to '/'.
            await navigate(cdp, `${ORIGIN}/definitely-not-a-route/`);
            assert.equal(await evalJs(cdp, 'document.title'), 'Unfancy - Dashboard',
                'unknown document offline falls back to the home document');
        });
    } finally {
        cdp?.close();
        browser.child.kill();
        await new Promise(resolve => browser.child.on('exit', resolve));
        try { rmSync(browser.userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
        server.close();
    }
});
