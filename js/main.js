/**
 * Unfancy Dashboard - Main Entry Point (ES6 Module)
 */

import { loadPage, setupPopstate, setupSwipeNavigation } from './router.js';
import { initHome, updateHomeStatus } from './views/home.js';
import { initSteam, cleanupSteam } from './views/steam.js';
import { initSpotify } from './views/spotify.js';
import { initLoL } from './views/lol.js';
import { initSocials } from './views/socials.js';

let currentPageCleanup = null;

/**
 * Routes page names to their initialization logic.
 */
function triggerPageLogic(pageName, signal = null) {
    // Run cleanup of previous page if exists
    if (currentPageCleanup) {
        currentPageCleanup();
        currentPageCleanup = null;
    }

    switch (pageName) {
        case 'home':
            initHome(signal);
            break;
        case 'steam':
            initSteam(signal);
            currentPageCleanup = cleanupSteam;
            break;
        case 'spotify':
            initSpotify(signal);
            break;
        case 'lol':
            initLoL(signal);
            break;
        case 'socials':
            initSocials(signal);
            break;
        default:
            console.warn(`No logic defined for page: ${pageName}`);
    }
}

// Global click listener for navigation
document.addEventListener('click', (e) => {
    const link = e.target.closest('.nav-link');
    if (link) {
        e.preventDefault();
        loadPage(link.getAttribute('href'), true, triggerPageLogic);
    }
});

// Initialization on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
    // Setup back/forward button handling
    setupPopstate(triggerPageLogic);
    
    // Setup mobile swipe navigation
    setupSwipeNavigation((url) => loadPage(url, true, triggerPageLogic));

    // Determine initial page
    const contentDiv = document.getElementById('app-content');
    if (contentDiv && contentDiv.firstElementChild) {
        const initialPage = contentDiv.firstElementChild.id;
        triggerPageLogic(initialPage);
    }

    // Live Status Auto-Refresh (Home only)
    let refreshInterval = null;
    const startPolling = () => {
        if (!refreshInterval) {
            refreshInterval = setInterval(() => {
                if (document.getElementById('home')) {
                    // Note: This polling doesn't use the router's signal 
                    // because it happens within the page lifecycle.
                    // But we could create a local AbortController for it if needed.
                    updateHomeStatus();
                }
            }, 30000);
        }
    };
    const stopPolling = () => {
        clearInterval(refreshInterval);
        refreshInterval = null;
    };

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopPolling();
        else startPolling();
    });

    startPolling();
});
