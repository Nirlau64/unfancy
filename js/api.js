/**
 * Unfancy Dashboard - API Helpers
 */

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
        const res = await fetch(finalUrl, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log('Fetch aborted:', url);
            throw err; // Re-throw to be handled by caller if needed
        }
        console.error("Fetch Error:", err);
        throw err;
    }
}
