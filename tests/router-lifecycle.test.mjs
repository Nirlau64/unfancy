/**
 * Router and view lifecycle regression tests (P3).
 *
 * Covers: rapid navigation (late fragments must not clobber the newer view),
 * navigation-signal coupling for view requests, back/forward (popstate)
 * handling and the uniform view cleanup contract (Spotify controller).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Minimal DOM stub sufficient for js/router.js loadPage().
 */
function stubDom() {
    const docListeners = new Map();
    const winListeners = new Map();
    const content = {
        innerHTML: '',
        classNames: new Set(),
        classList: {
            add(c) { content.classNames.add(c); },
            remove(c) { content.classNames.delete(c); }
        },
        querySelectorAll: () => [],
        querySelector: () => null
    };
    const document = {
        getElementById: (id) => (id === 'app-content' ? content : null),
        querySelectorAll: () => [],
        addEventListener: (type, fn) => {
            docListeners.set(type, [...(docListeners.get(type) || []), fn]);
        },
        dispatch: (type, event) => {
            for (const fn of docListeners.get(type) || []) fn(event);
        }
    };
    const windowAddEventListener = (type, fn) => {
        winListeners.set(type, [...(winListeners.get(type) || []), fn]);
    };
    const dispatchWindow = (type, event) => {
        for (const fn of winListeners.get(type) || []) fn(event);
    };
    const history = { pushStateCalls: [], pushState(state, title, url) { this.pushStateCalls.push(url); } };
    globalThis.document = document;
    globalThis.window = {
        addEventListener: windowAddEventListener,
        history,
        matchMedia: () => ({ matches: true }) // reduced motion: no transition delay
    };
    return { content, document, history, dispatchWindow };
}

test('rapid navigation: a late fragment response never commits over the newer view', async () => {
    const { content } = stubDom();
    const router = await import('../js/router.js?lifecycle-rapid');

    let releaseSteam;
    const steamGate = new Promise(resolve => { releaseSteam = resolve; });
    const fetchCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
        fetchCalls.push(String(input));
        if (String(input).includes('steam')) {
            await steamGate; // steam hangs until released
            return new Response('<h1>steam</h1>', { status: 200 });
        }
        return new Response('<h1>spotify</h1>', { status: 200 });
    };

    try {
        const committed = [];
        const first = router.loadPage('steam', false, (page) => committed.push(page));
        const second = router.loadPage('spotify', false, (page) => committed.push(page));
        await second;
        await new Promise(resolve => setTimeout(resolve, 10));

        // Spotify committed, steam never did — even before its fragment arrives.
        assert.deepEqual(committed, ['spotify']);
        assert.equal(content.innerHTML, '<h1>spotify</h1>');

        releaseSteam();
        await first;
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(committed, ['spotify'], 'late steam response must not commit');
        assert.equal(content.innerHTML, '<h1>spotify</h1>');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('navigation signal: the previous view logic signal is aborted by the next navigation', async () => {
    stubDom();
    const router = await import('../js/router.js?lifecycle-signal');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => new Response(`<h1>${input}</h1>`, { status: 200 });

    try {
        const signals = [];
        const logic = (page, signal) => signals.push({ page, signal });
        await router.loadPage('steam', false, logic);
        await router.loadPage('lol', false, logic);

        assert.equal(signals.length, 2);
        assert.equal(signals[0].page, 'steam');
        assert.equal(signals[1].page, 'lol');
        assert.equal(signals[0].signal.aborted, true, 'steam view signal must be aborted by the lol navigation');
        assert.equal(signals[1].signal.aborted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('back/forward: popstate loads the target page without pushing new history', async () => {
    const { history, dispatchWindow } = stubDom();
    const router = await import('../js/router.js?lifecycle-popstate');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => new Response(`<h1>${input}</h1>`, { status: 200 });

    try {
        const committed = [];
        router.setupPopstate((page) => committed.push(page));
        // Simulate the user pressing back: popstate with a history state.
        dispatchWindow('popstate', { state: { page: 'steam' } });
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.deepEqual(history.pushStateCalls, [], 'popstate-driven and explicit pushState=false loads must not push history');
        assert.deepEqual(committed, ['steam'], 'popstate must load the history state page');
        assert.equal(globalThis.document.getElementById('app-content').innerHTML, '<h1>/pages/steam.html</h1>');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('view cleanup contract: cleanupSpotify aborts pending view requests and chains the navigation signal', async () => {
    const { document } = stubDom();
    const spotifyView = await import('../js/views/spotify.js?lifecycle-cleanup');
    const apiModule = await import('../js/api.js?lifecycle-cleanup');

    const activeButtons = [];
    const fakeButton = () => ({
        classList: { add() {}, remove() {} },
        addEventListener(type, fn) { activeButtons.push(fn); },
        dataset: { range: 'short_term' }
    });
    const fakeDiv = () => ({
        isConnected: true,
        firstChild: null,
        style: {},
        innerHTML: '',
        appendChild() {},
        removeChild() {}
    });

    globalThis.document = {
        ...document,
        createElement: () => ({ className: '', appendChild() {} }),
        querySelectorAll: (sel) => (sel.includes('time-range') ? [fakeButton(), fakeButton()] : []),
        getElementById: (id) => (id.startsWith('spotify-') ? fakeDiv() : null)
    };

    const originalFetch = globalThis.fetch;
    const capturedSignals = [];
    globalThis.fetch = async (input, init) => {
        capturedSignals.push(init?.signal ?? null);
        return new Promise(() => {}); // pending until aborted
    };

    try {
        const navigationSignal = AbortSignal.abort(); // simulates an already-left view
        spotifyView.initSpotify(navigationSignal);
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.ok(capturedSignals.length >= 3, 'artists, tracks and now-playing requests must be issued');
        for (const signal of capturedSignals) {
            assert.ok(signal, 'every view request must carry an abort signal');
            assert.equal(signal.aborted, true, 'requests must be coupled to the navigation signal');
        }

        // Cleanup contract on a live view: navigation signal stays open, but
        // cleanupSpotify must abort everything.
        capturedSignals.length = 0;
        spotifyView.initSpotify(null);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.ok(capturedSignals.every(s => s && !s.aborted), 'live view requests start unaborted');
        spotifyView.cleanupSpotify();
        assert.ok(capturedSignals.every(s => s.aborted), 'cleanupSpotify must abort all pending view requests');
    } finally {
        globalThis.fetch = originalFetch;
        void apiModule;
    }
});
