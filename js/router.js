/**
 * Unfancy Dashboard - Router (Fragment-based SPA)
 */

import { renderError } from './utils.js';

/**
 * Maps page names to their fragment file paths.
 */
const PAGE_MAP = {
    home: 'pages/home.html',
    steam: 'pages/steam.html',
    spotify: 'pages/spotify.html',
    lol: 'pages/lol.html',
    socials: 'pages/socials.html'
};

const pageCache = new Map();
const pageFetches = new Map();
let currentAbortController = null;

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
export async function loadPage(pageName, pushState = true, triggerLogicFn) {
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
            const url = pageName === 'home' ? '/' : `/?page=${pageName}`;
            window.history.pushState({ page: pageName }, '', url);
        }

        // Update Nav Links
        document.querySelectorAll('.nav-tabs .nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.page === pageName);
        });

        // Trigger Page Specific Logic
        if (triggerLogicFn) {
            triggerLogicFn(pageName, signal);
        }

        // Finish transition
        contentDiv.classList.remove('fade-out');

        // A11y: Set focus to the first heading of the new content
        const firstHeading = contentDiv.querySelector('h1, h2, h3');
        if (firstHeading) {
            firstHeading.setAttribute('tabindex', '-1');
            firstHeading.focus();
        }

    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error("Routing Error:", e);
        contentDiv.classList.remove('fade-out');
        renderError(contentDiv, `Seite konnte nicht geladen werden: ${e.message}`, () => loadPage(pageName, pushState, triggerLogicFn));
    }
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
 * Handles swipe gestures for navigation.
 */
export function setupSwipeNavigation(loadPageFn) {
    let touchStartX = 0;
    let touchEndX = 0;
    const swipeThreshold = 80;

    document.addEventListener('touchstart', e => {
        // Only track single-finger touches to avoid multi-touch false positives
        if (e.touches.length !== 1) return;
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    document.addEventListener('touchend', e => {
        touchEndX = e.changedTouches[0].screenX;

        // Don't navigate if the user is scrolling a horizontally-scrollable element
        if (e.target.closest('.lol-table-wrap')) return;

        const navLinks = Array.from(document.querySelectorAll('.nav-tabs .nav-link'));
        const currentIndex = navLinks.findIndex(l => l.classList.contains('active'));
        if (currentIndex === -1) return;

        let targetIndex = -1;
        if (touchStartX - touchEndX > swipeThreshold) {
            // Swipe Left -> Next
            targetIndex = (currentIndex + 1) % navLinks.length;
        } else if (touchEndX - touchStartX > swipeThreshold) {
            // Swipe Right -> Prev
            targetIndex = (currentIndex - 1 + navLinks.length) % navLinks.length;
        }

        if (targetIndex !== -1) {
            loadPageFn(navLinks[targetIndex].dataset.page);
        }
    }, { passive: true });

    // Reset touch state on cancel to prevent stale values
    document.addEventListener('touchcancel', () => {
        touchStartX = 0;
        touchEndX = 0;
    }, { passive: true });
}
