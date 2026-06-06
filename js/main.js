/**
 * Unfancy Dashboard - Main Entry Point (ES6 Module)
 */

import { loadPage, setupPopstate, setupSwipeNavigation, preCachePage, getPageFromURL } from './router.js';
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

    // Reset page title (in case it was changed by Spotify Live Status)
    document.title = 'Unfancy - Dashboard';

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
        loadPage(link.dataset.page, true, triggerPageLogic);
    }
});

// Global keyboard listener for tab navigation (Arrow Keys)
document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const navLinks = Array.from(document.querySelectorAll('.nav-link'));
        const currentIndex = navLinks.findIndex(l => l.classList.contains('active'));
        if (currentIndex === -1) return;

        let targetIndex;
        if (e.key === 'ArrowLeft') {
            targetIndex = (currentIndex - 1 + navLinks.length) % navLinks.length;
        } else {
            targetIndex = (currentIndex + 1) % navLinks.length;
        }
        
        loadPage(navLinks[targetIndex].dataset.page, true, triggerPageLogic);
    }
});

// Initialization on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
    // Dynamic footer year
    const footerYear = document.getElementById('footer-year');
    if (footerYear) {
        footerYear.textContent = new Date().getFullYear();
    }

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(err => {
            console.warn('Service Worker registration failed:', err);
        });
    }

    // Setup back/forward button handling
    setupPopstate(triggerPageLogic);
    
    // Setup mobile swipe navigation
    setupSwipeNavigation((pageName) => loadPage(pageName, true, triggerPageLogic));

    // Pre-cache the inline home content so returning to home is instant
    const contentDiv = document.getElementById('app-content');
    if (contentDiv) {
        preCachePage('home', contentDiv.innerHTML);
    }

    // Determine initial page from URL (?page= param or default to home)
    const requestedPage = getPageFromURL();

    if (requestedPage !== 'home') {
        // User arrived via redirect stub (e.g. ?page=steam) — load that page
        loadPage(requestedPage, false, triggerPageLogic);
    } else {
        // Home content is already inline — just trigger its JS logic
        triggerPageLogic('home');
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
