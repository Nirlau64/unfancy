/**
 * Unfancy Dashboard - Router
 */

import { renderError } from './utils.js';

const pageCache = new Map();
let currentAbortController = null;

/**
 * Loads a page by URL, handles caching, transitions and A11y focus.
 */
export async function loadPage(url, pushState = true, triggerLogicFn) {
    const contentDiv = document.getElementById('app-content');
    if (!contentDiv) return;

    // Abort previous requests
    if (currentAbortController) {
        currentAbortController.abort();
    }
    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    // Start transition
    contentDiv.classList.add('fade-out');

    try {
        let newContentHTML;
        let pageName;

        // Check Cache
        if (pageCache.has(url)) {
            const cached = pageCache.get(url);
            newContentHTML = cached.html;
            pageName = cached.name;
        } else {
            const response = await fetch(url, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const htmlText = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, 'text/html');
            const newMain = doc.getElementById('app-content');
            
            if (!newMain) throw new Error("Invalid structure");
            
            newContentHTML = newMain.innerHTML;
            pageName = newMain.firstElementChild.id;
            
            // Store in cache
            pageCache.set(url, { html: newContentHTML, name: pageName });
        }

        // Wait for fade-out animation
        await new Promise(r => setTimeout(r, 300));

        // Final check before DOM update
        if (signal.aborted) return;

        // Update DOM
        contentDiv.innerHTML = newContentHTML;
        
        if (pushState) {
            window.history.pushState({ path: url }, '', url);
        }

        // Update Nav Links
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.page === pageName);
        });

        // Trigger Page Specific Logic
        if (triggerLogicFn) {
            // Pass the signal to the view logic to handle internal fetches
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
        renderError(contentDiv, `Seite konnte nicht geladen werden: ${e.message}`, () => loadPage(url, pushState, triggerLogicFn));
    }
}

/**
 * Handles browser back/forward buttons.
 */
export function setupPopstate(triggerLogicFn) {
    window.addEventListener('popstate', () => {
        loadPage(window.location.pathname, false, triggerLogicFn);
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
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    document.addEventListener('touchend', e => {
        touchEndX = e.changedTouches[0].screenX;
        const navLinks = Array.from(document.querySelectorAll('.nav-link'));
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
            loadPageFn(navLinks[targetIndex].getAttribute('href'));
        }
    }, { passive: true });
}
