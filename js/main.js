/**
 * Unfancy Dashboard - Main Entry Point (ES6 Module)
 */

import {
    loadPage,
    setupPopstate,
    setupSwipeNavigation,
    preCachePage,
    preloadPageFragments,
    getPageFromURL,
    getNextNavIndex
} from './router.js';
import { initHome, updateHomeStatus } from './views/home.js';
import { initSteam, cleanupSteam } from './views/steam.js';
import { initSpotify, cleanupSpotify } from './views/spotify.js';
import { initLoL } from './views/lol.js';
import { initSocials } from './views/socials.js';

let currentPageCleanup = null;

/**
 * Routes page names to their initialization logic.
 */
function triggerPageLogic(pageName, signal = null) {
    // Run cleanup of previous page if exists
    runPageCleanup();

    // Reset page title (in case it was changed by Spotify Live Status), but keep
    // the unique per-page titles that also power the static deep-link routes.
    document.title = {
        home: 'Unfancy - Dashboard',
        steam: 'Unfancy - Steam Statistiken',
        spotify: 'Unfancy - Spotify',
        lol: 'Unfancy - League of Legends',
        socials: 'Unfancy - Socials'
    }[pageName] || 'Unfancy - Dashboard';

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
            currentPageCleanup = cleanupSpotify;
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

    // The live-status poller only makes sense while the home view is shown.
    if (pageName === 'home') startHomePolling();
    else stopHomePolling();
}

/**
 * Uniform view cleanup contract: a view registers its teardown (abort
 * controllers, chart instances, timers) via currentPageCleanup and it is
 * guaranteed to run before the next view initializes.
 */
function runPageCleanup() {
    if (currentPageCleanup) {
        currentPageCleanup();
        currentPageCleanup = null;
    }
}

function waitForServiceWorkerControl() {
    if (!('serviceWorker' in navigator) || navigator.serviceWorker.controller) {
        return Promise.resolve();
    }

    // On the first visit, let the new worker claim this page before warming its cache.
    const serviceWorker = navigator.serviceWorker;
    return new Promise(resolve => {
        let timeoutId;
        const finish = () => {
            window.clearTimeout(timeoutId);
            serviceWorker.removeEventListener('controllerchange', finish);
            resolve();
        };
        serviceWorker.addEventListener('controllerchange', finish, { once: true });
        timeoutId = window.setTimeout(finish, 1500);
        if (serviceWorker.controller) finish();
    });
}

function schedulePagePrefetch() {
    const connection = navigator.connection;
    if (connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType)) return;

    const runWhenIdle = () => {
        const preload = async () => {
            await waitForServiceWorkerControl();
            void preloadPageFragments();
        };
        if (window.requestIdleCallback) {
            window.requestIdleCallback(preload, { timeout: 2000 });
        } else {
            window.setTimeout(preload, 1000);
        }
    };

    if (document.readyState === 'complete') {
        runWhenIdle();
    } else {
        window.addEventListener('load', runWhenIdle, { once: true });
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

// Keyboard listener for tab navigation (Arrow Keys).
// Only active while focus is inside the main navigation so arrow keys keep
// their native behavior in forms, lists and scrollable content elsewhere.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (!e.target.closest?.('#nav-tabs')) return;

    const navLinks = Array.from(document.querySelectorAll('.nav-tabs .nav-link'));
    const currentIndex = navLinks.findIndex(l => l.classList.contains('active'));
    const targetIndex = getNextNavIndex(e.key, currentIndex, navLinks.length);
    if (targetIndex === -1) return;

    // The navigation owns these keys while focused; don't scroll the page too.
    e.preventDefault();
    loadPage(navLinks[targetIndex].dataset.page, true, triggerPageLogic);
});

// Deterministic readiness marker for automated tests: the module's global
// listeners (click/swipe/popstate) are registered once this top-level code
// has run. Nothing below writes it again.
document.documentElement.dataset.unfancyReady = 'main';

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

    // Determine the initial page from the URL (static deep-link route,
    // ?page= param or default to home) BEFORE caching anything: the inline
    // <main> content only belongs to 'home' when home is actually the
    // initial route. On /steam/ the inline content is the Steam fragment and
    // must never be cached under the 'home' key.
    const requestedPage = getPageFromURL();

    if (requestedPage === 'home') {
        const contentDiv = document.getElementById('app-content');
        if (contentDiv) {
            // Pre-cache the inline home content so returning to home is instant
            preCachePage('home', contentDiv.innerHTML);
        }
        triggerPageLogic('home');
        schedulePagePrefetch();
    } else {
        // User arrived via a static deep-link route or a redirect stub
        // (e.g. /steam/ or ?page=steam) — load that page.
        loadPage(requestedPage, false, triggerPageLogic).finally(schedulePagePrefetch);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopHomePolling();
        else if (document.getElementById('home')) startHomePolling();
    });

    // Home is the initial route in the common case; triggerPageLogic manages
    // the poller from here on (start on home, stop on every other page).
    startHomePolling();
});

// Live Status Auto-Refresh (Home only). Started/stopped by the view lifecycle
// in triggerPageLogic so no home requests fire while another view is active.
let refreshInterval = null;
function startHomePolling() {
    if (refreshInterval || document.hidden) return;
    refreshInterval = setInterval(() => {
        if (document.getElementById('home')) {
            updateHomeStatus();
        }
    }, 60000);
}
function stopHomePolling() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}
