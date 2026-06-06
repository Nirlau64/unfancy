/**
 * Unfancy Dashboard - Global Utilities
 */

export const CONFIG = {
    STEAM_ID: "76561198159661156",
    API: {
        SPOTIFY: "https://spotify.api.nirlau.de",
        STEAM: "https://steam.api.nirlau.de",
        LOL: "https://api.nirlau.de/lol/Nirlau61/EUW/euw",
        YT_RSS: "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.youtube.com%2Ffeeds%2Fvideos.xml%3Fchannel_id%3DUCmr2wtpiZuDvwpShCNF9tng"
    },
    STEAM_BLOCKLIST: new Set([629520, 744190, 431960, 250820, 228980, 480]),
    DEFAULT_ACCENT: '#3b82f6'
};

let latestColorRequestID = 0;

/**
 * Gets dominant color from an image URL to update the theme.
 * Uses a request ID to prevent race conditions.
 */
export async function getDominantColor(imgUrl) {
    const requestID = ++latestColorRequestID;
    
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = imgUrl;
        img.onload = () => {
            if (requestID !== latestColorRequestID) return; // Ignore stale request
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = 1; canvas.height = 1;
                ctx.drawImage(img, 0, 0, 1, 1);
                const data = ctx.getImageData(0, 0, 1, 1).data;
                const color = `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
                resolve(color);
            } catch (e) {
                resolve(CONFIG.DEFAULT_ACCENT);
            }
        };
        img.onerror = () => resolve(CONFIG.DEFAULT_ACCENT);
        setTimeout(() => resolve(CONFIG.DEFAULT_ACCENT), 2000);
    });
}

/**
 * Updates CSS custom properties for the accent color.
 */
export function updateAccentColor(color) {
    if (!color) return;
    document.documentElement.style.setProperty('--accent', color);
    const rgba = color.replace('rgb', 'rgba').replace(')', ', 0.3)');
    document.documentElement.style.setProperty('--accent-muted', rgba);
    
    let themeMeta = document.querySelector('meta[name="theme-color"]');
    if (!themeMeta) {
        themeMeta = document.createElement('meta');
        themeMeta.name = "theme-color";
        document.head.appendChild(themeMeta);
    }
    themeMeta.content = color;
}

/**
 * Basic HTML escaping for security.
 */
export function escapeHTML(str) {
    if(typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag]));
}

export function minutesToHours(min) { 
    return (min / 60).toFixed(1); 
}

/**
 * Preloads images to prevent flickering on hover.
 */
export function preloadImages(urls) {
    if (!urls || !urls.length) return;
    urls.forEach(url => {
        if (!url) return;
        const img = new Image();
        img.src = url;
    });
}

/**
 * Renders an error message into a container with optional retry button.
 */
export function renderError(container, message, retryFn) {
    if (!container) return;
    
    // Clear container
    while (container.firstChild) container.removeChild(container.firstChild);

    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-msg';
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '10');
    svg.appendChild(circle);
    
    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line1.setAttribute('x1', '12'); line1.setAttribute('y1', '8'); line1.setAttribute('x2', '12'); line1.setAttribute('y2', '12');
    svg.appendChild(line1);
    
    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line2.setAttribute('x1', '12'); line2.setAttribute('y1', '16'); line2.setAttribute('x2', '12.01'); line2.setAttribute('y2', '16');
    svg.appendChild(line2);
    
    errorDiv.appendChild(svg);
    
    const p = document.createElement('p');
    p.textContent = message;
    errorDiv.appendChild(p);
    
    if (retryFn) {
        const btn = document.createElement('button');
        btn.className = 'btn-retry';
        btn.textContent = 'Erneut versuchen';
        btn.onclick = retryFn;
        errorDiv.appendChild(btn);
    }
    
    container.appendChild(errorDiv);
}

/**
 * Common logic for splash background hover effects.
 */
export function setupSplashHover(container, itemSelector, bgSelector) {
    const splashBg = container.querySelector(bgSelector);
    const items = container.querySelectorAll(itemSelector);
    if (!splashBg || !items.length) return;
    
    items.forEach(item => {
        item.addEventListener('mouseenter', () => {
            const url = item.dataset.splash || item.querySelector('img')?.src;
            if (url) {
                splashBg.style.backgroundImage = `url('${url}')`;
                splashBg.style.opacity = '1';
            }
        });
        item.addEventListener('mouseleave', () => {
            splashBg.style.opacity = '0';
        });
    });
}

/**
 * Converts a Unix timestamp or Date object into a readable relative time string.
 */
export function getRelativeTime(date) {
    if (!date) return 'Unbekannt';
    const timeMs = typeof date === 'number' ? date : (date instanceof Date ? date.getTime() : new Date(date).getTime());
    if (isNaN(timeMs)) return 'Unbekannt';
    const deltaSeconds = Math.round((Date.now() - timeMs) / 1000);
    const cutoffs = [60, 3600, 86400, 86400 * 7, 86400 * 30, 86400 * 365, Infinity];
    const units = ['Sekunde', 'Minute', 'Stunde', 'Tag', 'Woche', 'Monat', 'Jahr'];
    const unitsPlural = ['Sekunden', 'Minuten', 'Stunden', 'Tagen', 'Wochen', 'Monaten', 'Jahren'];
    
    let unitIndex = cutoffs.findIndex(cutoff => cutoff > Math.abs(deltaSeconds));
    let divisor = unitIndex ? cutoffs[unitIndex - 1] : 1;
    let rtfValue = Math.floor(Math.abs(deltaSeconds) / divisor);
    
    if (deltaSeconds === 0) return 'gerade eben';
    
    const unitName = rtfValue === 1 ? units[unitIndex] : unitsPlural[unitIndex];
    return deltaSeconds > 0 ? `vor ${rtfValue} ${unitName}` : `in ${rtfValue} ${unitName}`;
}

/**
 * Adds skeleton loading placeholders to a container
 */
export function renderSkeleton(container, type = 'list', count = 3) {
    if (!container) return;
    container.innerHTML = '';
    
    const wrap = document.createElement('div');
    wrap.className = 'skeleton-wrap';
    
    for (let i=0; i<count; i++) {
        const item = document.createElement('div');
        item.className = `skeleton skeleton-${type}`;
        wrap.appendChild(item);
    }
    
    container.appendChild(wrap);
}

/**
 * Removes skeleton loading placeholders from a container
 */
export function removeSkeleton(container) {
    if (!container) return;
    const wrap = container.querySelector('.skeleton-wrap');
    if (wrap) container.removeChild(wrap);
}
