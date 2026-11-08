const PATCH_LIST_URL = 'https://ddragon.leagueoflegends.com/api/versions.json';
const QUEUE_LIST_URL = 'https://static.developer.riotgames.com/docs/lol/queues.json';

class HttpStatusError extends Error {
    constructor(status) {
        super(`HTTP ${status}`);
        this.status = status;
    }
}

class InvalidPayloadError extends Error {
    constructor() {
        super('Invalid response payload');
        this.name = 'InvalidPayloadError';
    }
}

class ConfigurationError extends Error {
    constructor() {
        super('The required stats request function is unavailable');
        this.name = 'ConfigurationError';
    }
}

function describeFailure(error) {
    if (Number.isInteger(error?.status)) return `HTTP ${error.status}`;
    if (error?.name === 'TimeoutError') return 'Zeitüberschreitung';
    if (error?.name === 'SyntaxError') return 'Ungültige JSON-Antwort';
    if (error?.name === 'InvalidPayloadError') return 'Ungültiges Antwortformat';
    if (error?.name === 'ConfigurationError') return 'Frontend-Konfiguration fehlerhaft';
    return 'Netzwerkfehler';
}

export class LoLDataError extends Error {
    constructor(resource, cause) {
        const reason = describeFailure(cause);
        super(`${resource}: ${reason}`, { cause });
        this.name = 'LoLDataError';
        this.resource = resource;
        this.reason = reason;
    }
}

function abortReason(signal) {
    return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function requestSignal(signal, timeoutMs) {
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), signal].filter(Boolean));
}

async function fetchJsonResource(resource, url, fetchImpl, signal, timeoutMs) {
    try {
        const response = await fetchImpl(url, {
            signal: requestSignal(signal, timeoutMs),
            cache: 'no-store'
        });
        if (!response.ok) throw new HttpStatusError(response.status);
        return await response.json();
    } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        throw new LoLDataError(resource, error);
    }
}

function validStatsPayload(data) {
    return data !== null && typeof data === 'object' && !Array.isArray(data)
        && Number.isFinite(data.level)
        && data.level >= 0
        && Array.isArray(data.masteryTop3)
        && Array.isArray(data.recentMatches);
}

function shouldRetryStats(error) {
    if (Number.isInteger(error?.status)) return error.status >= 500 && error.status <= 599;
    // The worker request already has a 30-second deadline; retrying a timeout
    // would double the wait for a hard failure. Retry fast network/5xx failures only.
    return error?.name === 'TypeError';
}

function waitBeforeRetry(delayMs, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortReason(signal));
            return;
        }

        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, delayMs);
        const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(abortReason(signal));
        };
        signal?.addEventListener('abort', abort, { once: true });
    });
}

async function fetchStatsWithRetry(fetchAPI, apiUrl, signal, retryDelayMs) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            // Keep useCacheBusting=false and explicitly bypass browser caches for Riot data.
            const data = await fetchAPI(apiUrl, false, signal, 30000, 'no-store');
            if (!validStatsPayload(data)) throw new InvalidPayloadError();
            return data;
        } catch (error) {
            if (signal?.aborted) throw abortReason(signal);
            const retryCause = error instanceof LoLDataError ? error.cause ?? error : error;
            if (attempt === 0 && shouldRetryStats(retryCause)) {
                await waitBeforeRetry(retryDelayMs, signal);
                continue;
            }
            if (error instanceof LoLDataError) throw error;
            throw new LoLDataError('Riot-Statistik-API', error);
        }
    }
}

function settledOptional(result, resource, validate, mapValue, warnings) {
    if (result.status === 'rejected') {
        const error = result.reason;
        warnings.push({
            resource,
            reason: error instanceof LoLDataError ? error.reason : describeFailure(error)
        });
        return null;
    }

    if (!validate(result.value)) {
        warnings.push({ resource, reason: 'Ungültiges Antwortformat' });
        return null;
    }

    return mapValue(result.value);
}

export async function loadLoLResources({
    fetchImpl = globalThis.fetch,
    fetchAPI,
    apiUrl,
    signal = null,
    retryDelayMs = 500
}) {
    if (typeof fetchAPI !== 'function') {
        throw new LoLDataError('LoL-Statistik-Loader', new ConfigurationError());
    }

    const versionsPromise = fetchJsonResource(
        'Data Dragon Patchliste', PATCH_LIST_URL, fetchImpl, signal, 7000
    );
    const queuesPromise = fetchJsonResource(
        'Riot-Queue-Metadaten', QUEUE_LIST_URL, fetchImpl, signal, 7000
    );
    const [stats, [versionsResult, queuesResult]] = await Promise.all([
        fetchStatsWithRetry(fetchAPI, apiUrl, signal, retryDelayMs),
        Promise.allSettled([versionsPromise, queuesPromise])
    ]);

    if (signal?.aborted) throw abortReason(signal);

    const warnings = [];
    const patch = settledOptional(
        versionsResult,
        'Data Dragon Patchliste',
        value => Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0,
        value => value[0],
        warnings
    );
    const queueMap = settledOptional(
        queuesResult,
        'Riot-Queue-Metadaten',
        Array.isArray,
        queues => Object.fromEntries(queues
            .filter(queue => Number.isFinite(queue?.queueId))
            .map(queue => [
                queue.queueId,
                typeof queue.description === 'string' && queue.description
                    ? queue.description
                    : `Queue ${queue.queueId}`
            ])),
        warnings
    ) ?? {};

    let champMap = {};
    if (patch) {
        const [championResult] = await Promise.allSettled([
            fetchJsonResource(
                'Data Dragon Champion-Daten',
                `https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(patch)}/data/en_US/champion.json`,
                fetchImpl,
                signal,
                10000
            )
        ]);

        if (signal?.aborted) throw abortReason(signal);
        champMap = settledOptional(
            championResult,
            'Data Dragon Champion-Daten',
            value => value?.data !== null && typeof value?.data === 'object' && !Array.isArray(value.data),
            payload => Object.fromEntries(Object.values(payload.data)
                .filter(champion => champion && champion.key != null
                    && typeof champion.name === 'string' && champion.name
                    && typeof champion.id === 'string' && champion.id)
                .map(champion => [String(champion.key), {
                    name: champion.name,
                    id: champion.id,
                    img: `https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(patch)}/img/champion/${encodeURIComponent(champion.id)}.png`
                }])),
            warnings
        ) ?? {};
    }

    return { data: stats, champMap, queueMap, warnings };
}

export function formatLoLLoadError(error) {
    const details = error instanceof LoLDataError
        ? `${error.resource}: ${error.reason}`
        : `LoL-Daten: ${describeFailure(error)}`;
    return `${details}. Bitte erneut versuchen.`;
}

export function formatLoLMetadataWarning(warnings) {
    if (!warnings?.length) return '';
    const details = warnings.map(item => `${item.resource} (${item.reason})`).join(', ');
    return `Zusatzdaten nicht verfügbar: ${details}. Statistiken werden soweit möglich mit Fallback-Bezeichnungen angezeigt.`;
}
