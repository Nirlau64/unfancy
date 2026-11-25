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
 * Fetches data from an API with optional cache busting, cache mode, and AbortSignal support.
 */
export async function fetchAPI(url, useCacheBusting = false, signal = null, timeoutMs = 10000, cacheMode = 'default') {
    try {
        let finalUrl = url;
        if (useCacheBusting) {
            const sep = url.includes('?') ? '&' : '?';
            finalUrl = `${url}${sep}t=${Date.now()}`;
        }
        const res = await fetch(finalUrl, {
            signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal].filter(Boolean)),
            cache: cacheMode
        });
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

/**
 * Consistent data status model for integrations.
 * - fresh: a new payload was successfully loaded
 * - stale: the refresh failed, but a previously loaded payload is still shown
 * - error: the load failed and no cached payload exists
 */
export const DataStatus = {
    FRESH: 'fresh',
    STALE: 'stale',
    ERROR: 'error'
};

/**
 * Wraps a loader function and keeps the last successful payload so callers can
 * degrade to stale data instead of losing the whole section on a failed refresh.
 * load() never throws (except AbortError, which is user-initiated cancellation
 * and must stay observable for the caller) — it resolves with a status object:
 * { status, data, fetchTime, error }.
 */
export class DataStatusSource {
    constructor(loader) {
        this.loader = loader;
        this.lastData = null;
        this.lastFetchTime = null;
    }

    async load(signal = null) {
        try {
            const data = await this.loader(signal);
            this.lastData = data;
            this.lastFetchTime = Date.now();
            return { status: DataStatus.FRESH, data, fetchTime: this.lastFetchTime, error: null };
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            if (this.lastData !== null) {
                return { status: DataStatus.STALE, data: this.lastData, fetchTime: this.lastFetchTime, error: err };
            }
            return { status: DataStatus.ERROR, data: null, fetchTime: null, error: err };
        }
    }
}

/**
 * Combines multiple load results into a single status for a view section:
 * - error if any result errored without cached data
 * - stale if any result degraded to cached data
 * - fresh otherwise
 */
export function combineDataStatus(results) {
    if (results.some(r => r?.status === DataStatus.ERROR)) return DataStatus.ERROR;
    if (results.some(r => r?.status === DataStatus.STALE)) return DataStatus.STALE;
    return DataStatus.FRESH;
}
