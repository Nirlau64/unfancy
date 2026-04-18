/**
 * Unfancy Dashboard - Main Entry Point (ES6 Module)
 */

import { loadPage, setupPopstate, setupSwipeNavigation } from './router.js';
import { initHome, updateHomeStatus } from './views/home.js';
import { initSteam } from './views/steam.js';
import { initSpotify } from './views/spotify.js';
import { initLoL } from './views/lol.js';
import { initSocials } from './views/socials.js';

/**
 * Routes page names to their initialization logic.
 */
function triggerPageLogic(pageName) {
    switch (pageName) {
        case 'home':
            initHome();
            break;
        case 'steam':
            initSteam();
            break;
        case 'spotify':
            initSpotify();
            break;
        case 'lol':
            initLoL();
            break;
        case 'socials':
            initSocials();
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
    setupPopstate(triggerLogic);
    
    // Setup mobile swipe navigation
    setupSwipeNavigation((url) => loadPage(url, true, triggerLogic));

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

// Helper wrapper for router
function triggerLogic(pageName) {
    triggerPageLogic(pageName);
}
