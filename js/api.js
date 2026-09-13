/**
 * Unfancy Dashboard - API Helpers
 */

export class APIError extends Error {
    constructor(message, status, payload = null) {
        super(message);
        this.name = 'APIError';
        this.status = status;
        this.payload = payload;
    }
}

/**
 * Fetches data from an API with optional cache busting and AbortSignal support.
 */
export async function fetchAPI(url, useCacheBusting = false, signal = null) {
    try {
        let finalUrl = url;
        if (useCacheBusting) {
            const sep = url.includes('?') ? '&' : '?';
            finalUrl = `${url}${sep}t=${Date.now()}`;
        }
        const res = await fetch(finalUrl, { signal: AbortSignal.any([AbortSignal.timeout(10000), signal].filter(Boolean)) });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
            const message = payload?.error || `HTTP ${res.status}`;
            throw new APIError(message, res.status, payload);
        }
        return payload;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log('Fetch aborted:', url);
            throw err; // Re-throw to be handled by caller if needed
        }
        console.error("Fetch Error:", err);
        throw err;
    }
}
