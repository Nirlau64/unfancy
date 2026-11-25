/**
 * Unfancy Dashboard - Router (Fragment-based SPA)
 */

import { renderError } from './utils.js';

/**
 * Maps page names to their fragment file paths.
 */
const PAGE_MAP = {
    home: '/pages/home.html',
    steam: '/pages/steam.html',
    spotify: '/pages/spotify.html',
    lol: '/pages/lol.html',
    socials: '/pages/socials.html'
};

const pageCache = new Map();
const pageFetches = new Map();
let currentAbortController = null;

/**
 * Announces a page change to screen readers via the #page-announcer live region.
 * @param {string} pageName - The page that was loaded
 * @param {Element|null} firstHeading - The heading that received focus, if any
 */
function announcePage(pageName, firstHeading) {
    const announcer = document.getElementById('page-announcer');
    if (!announcer) return;
    const label = (firstHeading?.textContent || pageName).trim();
    // Reassign the same text only when it changes; identical text is not re-announced.
    if (announcer.textContent !== label) {
        announcer.textContent = label;
    }
}

// Clean public paths for the statically generated route pages. New history
// entries use these; the legacy `?page=` routes keep working because
// getPageFromURL() accepts both forms.
const CLEAN_PATHS = {
    steam: '/steam/',
    spotify: '/spotify/',
    lol: '/lol/',
    socials: '/socials/'
};

// A shared fragment fetch may finish after navigation changes, warming the cache for reuse.
function getPageHTML(pageName) {
    if (pageCache.has(pageName)) {
        return Promise.resolve(pageCache.get(pageName));
    }

    if (pageFetches.has(pageName)) {
        return pageFetches.get(pageName);
    }

    const request = fetch(PAGE_MAP[pageName])
        .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.text();
        })
        .then(html => {
            pageCache.set(pageName, html);
            return html;
        })
        .finally(() => {
            if (pageFetches.get(pageName) === request) {
                pageFetches.delete(pageName);
            }
        });

    pageFetches.set(pageName, request);
    return request;
}

/**
 * Loads a page by name, fetches its fragment, handles caching, transitions and A11y focus.
 * @param {string} pageName - The page identifier (e.g. 'steam', 'home')
 * @param {boolean} pushState - Whether to push a new history entry
 * @param {Function} triggerLogicFn - Callback to initialize the loaded page's JS logic
 */
export async function loadPage(pageName, pushState = true, triggerLogicFn, { focusHeading = true } = {}) {
    const contentDiv = document.getElementById('app-content');
    if (!contentDiv || !PAGE_MAP[pageName]) return;

    // Abort previous requests
    if (currentAbortController) {
        currentAbortController.abort();
    }
    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    // Start transition
    contentDiv.classList.add('fade-out');

    try {
        const pageWasCached = pageCache.has(pageName);
        const prefersReducedMotion = window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const contentPromise = getPageHTML(pageName);
        const transitionPromise = pageWasCached || prefersReducedMotion
            ? Promise.resolve()
            : new Promise(resolve => setTimeout(resolve, 180));
        const [newContentHTML] = await Promise.all([contentPromise, transitionPromise]);

        // Final check before DOM update
        if (signal.aborted) return;

        // Update DOM
        contentDiv.innerHTML = newContentHTML;

        if (pushState) {
            // Clean paths for the generated static routes, '/' for home.
            // Legacy ?page= URLs remain valid entry points via getPageFromURL.
            const url = pageName === 'home' ? '/' : (CLEAN_PATHS[pageName] || `/?page=${pageName}`);
            window.history.pushState({ page: pageName }, '', url);
        }

        // Update Nav Links (class for styling, aria-current for assistive tech)
        document.querySelectorAll('.nav-tabs .nav-link').forEach(link => {
            const isActive = link.dataset.page === pageName;
            link.classList.toggle('active', isActive);
            if (isActive) {
                link.setAttribute('aria-current', 'page');
            } else {
                link.removeAttribute('aria-current');
            }
        });

        // Trigger Page Specific Logic
        if (triggerLogicFn) {
            triggerLogicFn(pageName, signal);
        }

        // Finish transition
        contentDiv.classList.remove('fade-out');

        // A11y: move focus to the first heading of the new content, unless the
        // caller manages focus itself (keyboard nav keeps focus roving inside
        // the nav instead of yanking it into the content).
        const firstHeading = contentDiv.querySelector('h1, h2, h3');
        let headingFocused = false;
        if (firstHeading && focusHeading) {
            firstHeading.setAttribute('tabindex', '-1');
            firstHeading.focus();
            headingFocused = true;
        }

        // A11y: announce the new page via the live region only when focus was
        // NOT moved to the heading — focusing the heading already announces it
        // to screen readers, so both together would double-announce.
        if (!headingFocused) {
            announcePage(pageName, firstHeading);
        }

    } catch (e) {
        if (e.name === 'AbortError') return;
        // A newer navigation owns the content area; never clobber it with a
        // late error from a superseded request.
        if (signal.aborted) return;
        console.error("Routing Error:", e);
        contentDiv.classList.remove('fade-out');
        renderError(contentDiv, `Seite konnte nicht geladen werden: ${e.message}`, () => loadPage(pageName, pushState, triggerLogicFn));
    }
}

/**
 * Creates the document-level keydown handler for arrow-key navigation inside
 * the main navigation (#nav-tabs).
 *
 * Roving focus model: the target nav link receives focus immediately, so
 * consecutive arrow presses keep working without re-tabbing into the nav.
 * loadPage is asked to skip moving focus to the page heading (which would
 * pull focus out of the nav); the live region still announces the new page.
 * Outside the nav the arrow keys keep their native behavior.
 *
 * @param {object} [deps]
 * @param {Function} [deps.triggerLogicFn] Page logic trigger passed to loadPage.
 * @param {Function} [deps.loadPageFn] Navigation function (injectable for tests).
 * @returns {Function} A keydown handler; returns true when it consumed the key.
 */
export function createArrowNavHandler({ triggerLogicFn, loadPageFn = loadPage } = {}) {
    return function handleNavArrowKey(e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
        if (!e.target?.closest?.('#nav-tabs')) return false;

        const navLinks = Array.from(document.querySelectorAll('.nav-tabs .nav-link'));
        const currentIndex = navLinks.findIndex(l => l.classList.contains('active'));
        const targetIndex = getNextNavIndex(e.key, currentIndex, navLinks.length);
        if (targetIndex === -1) return false;

        // The navigation owns these keys while focused; don't scroll the page too.
        e.preventDefault();
        const targetLink = navLinks[targetIndex];
        // Roving focus: keep focus on the nav so the next arrow press works.
        targetLink.focus();
        loadPageFn(targetLink.dataset.page, true, triggerLogicFn, { focusHeading: false });
        return true;
    };
}

/**
 * Pre-caches a page's HTML so navigating back to it is instant.
 * Used to cache the inline home content on first load.
 */
export function preCachePage(pageName, html) {
    if (!pageCache.has(pageName)) {
        pageCache.set(pageName, html);
    }
}

/**
 * Warms uncached page fragments after the initial render without fetching API data.
 */
export async function preloadPageFragments() {
    const uncachedPages = Object.keys(PAGE_MAP).filter(pageName => !pageCache.has(pageName));
    await Promise.allSettled(uncachedPages.map(pageName => getPageHTML(pageName)));
}

/**
 * Reads the current page from the URL query parameter.
 * @returns {string} The page name (defaults to 'home')
 */
export function getPageFromURL() {
    // Static deep-link routes (e.g. /steam/) take precedence over the query param.
    const pathPage = window.location.pathname
        .replace(/^\/+|\/+$/g, '');
    if (PAGE_MAP[pathPage]) {
        return pathPage;
    }
    const params = new URLSearchParams(window.location.search);
    const page = params.get('page');
    return (page && PAGE_MAP[page]) ? page : 'home';
}

/**
 * Handles browser back/forward buttons.
 */
export function setupPopstate(triggerLogicFn) {
    window.addEventListener('popstate', (e) => {
        const pageName = e.state?.page || getPageFromURL();
        loadPage(pageName, false, triggerLogicFn);
    });
}

/**
 * Pure swipe decision used by setupSwipeNavigation (exported for tests).
 * A swipe counts only when it is clearly horizontal and beyond the threshold.
 * @returns {number} target index, or -1 when the gesture is not a navigation swipe
 */
export function resolveSwipeTarget({ startX, startY, endX, endY, threshold, currentIndex, count }) {
    if (count <= 0 || currentIndex < 0 || currentIndex >= count) return -1;
    const deltaX = startX - endX;
    const deltaY = startY - endY;
    // Require horizontal dominance so vertical scrolling never triggers navigation.
    if (Math.abs(deltaX) <= threshold || Math.abs(deltaX) <= Math.abs(deltaY)) return -1;
    if (deltaX > 0) {
        // Swipe Left -> Next
        return (currentIndex + 1) % count;
    }
    // Swipe Right -> Prev
    return (currentIndex - 1 + count) % count;
}

/**
 * Pure arrow-key navigation decision (exported for tests).
 * @param {string} key - KeyboardEvent.key ('ArrowLeft' or 'ArrowRight')
 * @returns {number} target index, or -1 when the key is not a navigation arrow
 */
export function getNextNavIndex(key, currentIndex, count) {
    if (count <= 0 || currentIndex < 0 || currentIndex >= count) return -1;
    if (key === 'ArrowLeft') return (currentIndex - 1 + count) % count;
    if (key === 'ArrowRight') return (currentIndex + 1) % count;
    return -1;
}

/**
 * Handles swipe gestures for navigation.
 */
export function setupSwipeNavigation(loadPageFn) {
    let touchStartX = 0;
    let touchStartY = 0;
    const swipeThreshold = 80;
    // Gestures starting on interactive elements are taps/scrolls, not navigation.
    const INTERACTIVE_SELECTOR = 'a, button, input, textarea, select, label, [contenteditable]';

    document.addEventListener('touchstart', e => {
        // Only track single-finger touches to avoid multi-touch false positives
        if (e.touches.length !== 1) return;
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
    }, { passive: true });

    document.addEventListener('touchend', e => {
        const touch = e.changedTouches[0];
        // Don't navigate if the gesture started on an interactive element
        // or inside a horizontally-scrollable element.
        if (!touch) return;
        if (e.target.closest?.(INTERACTIVE_SELECTOR)) return;
        if (e.target.closest?.('.lol-table-wrap')) return;

        const navLinks = Array.from(document.querySelectorAll('.nav-tabs .nav-link'));
        const currentIndex = navLinks.findIndex(l => l.classList.contains('active'));
        const targetIndex = resolveSwipeTarget({
            startX: touchStartX,
            startY: touchStartY,
            endX: touch.screenX,
            endY: touch.screenY,
            threshold: swipeThreshold,
            currentIndex,
            count: navLinks.length
        });

        if (targetIndex !== -1) {
            loadPageFn(navLinks[targetIndex].dataset.page);
        }
    }, { passive: true });

    // Reset touch state on cancel to prevent stale values
    document.addEventListener('touchcancel', () => {
        touchStartX = 0;
        touchStartY = 0;
    }, { passive: true });
}
