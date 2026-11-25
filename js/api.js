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
 * Header the service worker sets on cache-fallback responses (contract from
 * the sw.js cache policies: `X-Unfancy-Cache: stale`).
 */
const CACHE_MARK_HEADER = 'X-Unfancy-Cache';

/**
 * Symbol tag set on payloads that were served from the service worker's
 * cache fallback (header `X-Unfancy-Cache: stale`). Checked by
 * DataStatusSource so a cache-served payload is reported as stale instead
 * of fresh.
 */
export const STALE_CACHE_MARK = Symbol('unfancyStaleFromCache');

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
        // The service worker marks cache-fallback responses (X-Unfancy-Cache:
        // stale). Tag the payload so DataStatusSource can report it as stale
        // even though the HTTP request itself succeeded. Symbol key so the
        // mark never leaks into rendering or serialization.
        if (payload && typeof payload === 'object'
            && (res.headers?.get(CACHE_MARK_HEADER) || '').trim().toLowerCase() === 'stale') {
            payload[STALE_CACHE_MARK] = true;
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
 * - fresh: a new payload was successfully loaded (not a service-worker
 *   cache fallback; those carry `X-Unfancy-Cache: stale` and count as stale)
 * - stale: the refresh failed, but a previously loaded payload is still shown,
 *   or the service worker served a cache fallback marked stale
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
            // A successful HTTP response can still be a cache fallback
            // marked stale by the service worker (X-Unfancy-Cache: stale).
            const staleFromCache = data?.[STALE_CACHE_MARK] === true;
            this.lastData = data;
            this.lastFetchTime = Date.now();
            return {
                status: staleFromCache ? DataStatus.STALE : DataStatus.FRESH,
                data,
                fetchTime: this.lastFetchTime,
                error: null
            };
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
