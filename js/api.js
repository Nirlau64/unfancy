/**
 * Unfancy Dashboard - API Helpers
 */

/**
 * Fetches data from an API with optional cache busting.
 */
export async function fetchAPI(url, useCacheBusting = true) {
    try {
        let finalUrl = url;
        if (useCacheBusting) {
            const sep = url.includes('?') ? '&' : '?';
            finalUrl = `${url}${sep}t=${Date.now()}`;
        }
        const res = await fetch(finalUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error("Fetch Error:", err);
        throw err;
    }
}
