import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { getNextNavIndex, resolveSwipeTarget } from '../js/router.js';

const THRESHOLD = 80;
const COUNT = 5; // home, steam, spotify, lol, socials

test('horizontal swipe left of the threshold advances and wraps to the first page', () => {
    assert.equal(resolveSwipeTarget({
        startX: 300, startY: 100, endX: 200, endY: 100,
        threshold: THRESHOLD, currentIndex: 0, count: COUNT
    }), 1);
    assert.equal(resolveSwipeTarget({
        startX: 300, startY: 100, endX: 200, endY: 100,
        threshold: THRESHOLD, currentIndex: COUNT - 1, count: COUNT
    }), 0);
});

test('horizontal swipe right of the threshold goes back and wraps to the last page', () => {
    assert.equal(resolveSwipeTarget({
        startX: 200, startY: 100, endX: 300, endY: 100,
        threshold: THRESHOLD, currentIndex: 1, count: COUNT
    }), 0);
    assert.equal(resolveSwipeTarget({
        startX: 200, startY: 100, endX: 300, endY: 100,
        threshold: THRESHOLD, currentIndex: 0, count: COUNT
    }), COUNT - 1);
});

test('swipes below the threshold do not navigate', () => {
    assert.equal(resolveSwipeTarget({
        startX: 300, startY: 100, endX: 240, endY: 100,
        threshold: THRESHOLD, currentIndex: 0, count: COUNT
    }), -1);
    assert.equal(resolveSwipeTarget({
        startX: 300, startY: 100, endX: 300, endY: 100,
        threshold: THRESHOLD, currentIndex: 0, count: COUNT
    }), -1);
});

test('vertical scrolling gestures never trigger navigation', () => {
    // Vertical scroll of the same distance as a valid horizontal swipe
    assert.equal(resolveSwipeTarget({
        startX: 300, startY: 100, endX: 300, endY: 300,
        threshold: THRESHOLD, currentIndex: 0, count: COUNT
    }), -1);
    // Diagonal gesture dominated by the vertical component
    assert.equal(resolveSwipeTarget({
        startX: 300, startY: 100, endX: 210, endY: 400,
        threshold: THRESHOLD, currentIndex: 0, count: COUNT
    }), -1);
});

test('swipe decision rejects invalid indices and empty navigation', () => {
    const base = { startX: 300, startY: 100, endX: 100, endY: 100, threshold: THRESHOLD, count: COUNT };
    assert.equal(resolveSwipeTarget({ ...base, currentIndex: -1 }), -1);
    assert.equal(resolveSwipeTarget({ ...base, currentIndex: COUNT }), -1);
    assert.equal(resolveSwipeTarget({ ...base, currentIndex: 0, count: 0 }), -1);
});

test('arrow keys wrap in both directions and ignore other keys', () => {
    assert.equal(getNextNavIndex('ArrowRight', 0, COUNT), 1);
    assert.equal(getNextNavIndex('ArrowRight', COUNT - 1, COUNT), 0);
    assert.equal(getNextNavIndex('ArrowLeft', 0, COUNT), COUNT - 1);
    assert.equal(getNextNavIndex('ArrowLeft', COUNT - 1, COUNT), COUNT - 2);
    assert.equal(getNextNavIndex('ArrowDown', 0, COUNT), -1);
    assert.equal(getNextNavIndex('ArrowRight', -1, COUNT), -1);
    assert.equal(getNextNavIndex('ArrowRight', 0, 0), -1);
});

test('static markup exposes navigation semantics for assistive technology', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

    assert.match(html, /<nav[^>]*class="nav-tabs"[^>]*aria-label="[^"]+"/,
        'the main navigation needs an accessible name');
    assert.match(html, /class="nav-link active"[^>]*aria-current="page"/,
        'the initially active nav link must carry aria-current="page"');
    assert.match(html, /id="page-announcer"[^>]*aria-live="polite"/,
        'a live region must exist for page-change announcements');
    assert.match(html, /id="page-announcer"[^>]*class="sr-only"/,
        'the announcement live region must be visually hidden');

    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /\.sr-only\s*\{/, 'the sr-only utility must exist in style.css');
});

test('router keeps aria-current in sync with the active nav link', async () => {
    const routerSource = await readFile(new URL('../js/router.js', import.meta.url), 'utf8');
    assert.match(routerSource, /setAttribute\('aria-current', 'page'\)/);
    assert.match(routerSource, /removeAttribute\('aria-current'\)/);
    assert.match(routerSource, /announcePage\(pageName, firstHeading\)/);
});

test('arrow-key navigation is scoped to the nav instead of the whole document', async () => {
    const mainSource = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');
    assert.match(mainSource, /closest\?\.\('#nav-tabs'\)/,
        'arrow keys must only be handled when focus is inside the nav');
    assert.doesNotMatch(mainSource, /if \(e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'\) \{\s*const navLinks/,
        'the old document-wide arrow handling must be gone');
});
