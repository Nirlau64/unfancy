import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLoLLoadError, formatLoLMetadataWarning, loadLoLResources, LoLDataError } from '../js/lol-data.mjs';

const validStats = {
    level: 44,
    totalMasteryPoints: 123456,
    masteryTop3: [{ championId: 432, points: 123 }],
    recentMatches: [{ queueId: 420, gameMode: 'CLASSIC', you: { championId: 432 } }]
};

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

function createDependencies(overrides = {}) {
    const calls = { fetch: [], api: 0, apiArgs: [] };
    const fetchImpl = overrides.fetchImpl ?? (async (url, options) => {
        calls.fetch.push({ url: String(url), options });
        if (String(url).includes('versions.json')) return response(['16.22.1']);
        if (String(url).includes('queues.json')) return response([{ queueId: 420, description: 'Ranked Solo' }]);
        if (String(url).includes('champion.json')) {
            return response({ data: { Sona: { key: '432', name: 'Sona', id: 'Sona' } } });
        }
        throw new Error(`Unexpected URL: ${url}`);
    });
    const fetchAPI = overrides.fetchAPI ?? (async (...args) => {
        calls.api++;
        calls.apiArgs.push(args);
        return structuredClone(validStats);
    });
    return { calls, fetchImpl, fetchAPI };
}

const load = (deps, overrides = {}) => loadLoLResources({
    fetchImpl: deps.fetchImpl,
    fetchAPI: deps.fetchAPI,
    apiUrl: 'https://api.example.test/lol',
    retryDelayMs: 0,
    ...overrides
});

test('loads stats and maps champion/queue metadata on the happy path', async () => {
    const deps = createDependencies();
    const controller = new AbortController();
    const result = await load(deps, { signal: controller.signal });

    assert.deepEqual(result.data, validStats);
    assert.equal(result.champMap['432'].name, 'Sona');
    assert.equal(result.queueMap['420'], 'Ranked Solo');
    assert.deepEqual(result.warnings, []);
    assert.equal(deps.calls.api, 1);
    assert.deepEqual(deps.calls.apiArgs[0].slice(0, 2), ['https://api.example.test/lol', false]);
    assert.equal(deps.calls.apiArgs[0][2], controller.signal);
    assert.equal(deps.calls.apiArgs[0][3], 30000);
    assert.equal(deps.calls.apiArgs[0][4], 'no-store');
    assert.equal(deps.calls.fetch.length, 3);
    assert.ok(deps.calls.fetch.every(({ options }) => options.signal instanceof AbortSignal));
    assert.ok(deps.calls.fetch.every(({ options }) => options.cache === 'no-store'));
});

test('keeps usable stats when patch list and queue metadata fail', async () => {
    const deps = createDependencies({
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes('versions.json')) return response({ error: 'not an array' });
            if (value.includes('queues.json')) throw new TypeError('Failed to fetch');
            throw new Error(`Unexpected URL: ${url}`);
        }
    });

    const result = await load(deps);

    assert.equal(result.data.level, validStats.level);
    assert.deepEqual(result.champMap, {});
    assert.deepEqual(result.queueMap, {});
    assert.deepEqual(result.warnings.map(w => w.resource), ['Data Dragon Patchliste', 'Riot-Queue-Metadaten']);
    assert.deepEqual(result.warnings.map(w => w.reason), ['Ungültiges Antwortformat', 'Netzwerkfehler']);
});

test('treats an empty patch list as unavailable and skips champion lookup', async () => {
    const baseDeps = createDependencies();
    const deps = createDependencies({
        fetchImpl: async (url, options) => {
            if (String(url).includes('versions.json')) return response([]);
            return baseDeps.fetchImpl(url, options);
        }
    });

    const result = await load(deps);

    assert.deepEqual(result.champMap, {});
    assert.equal(result.data.level, validStats.level);
    assert.deepEqual(result.warnings.map(w => w.reason), ['Ungültiges Antwortformat']);
    assert.equal(baseDeps.calls.fetch.some(({ url }) => url.includes('champion.json')), false);
});

test('reports malformed optional JSON safely and retains stats', async () => {
    const baseDeps = createDependencies();
    const deps = createDependencies({
        fetchImpl: async (url, options) => {
            if (String(url).includes('versions.json')) {
                return { ok: true, status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } };
            }
            return baseDeps.fetchImpl(url, options);
        }
    });

    const result = await load(deps);

    assert.equal(result.data.level, validStats.level);
    assert.deepEqual(result.warnings.map(w => w.reason), ['Ungültige JSON-Antwort']);
});

test('keeps stats and adds a warning when champion data fails', async () => {
    const baseFetch = createDependencies().fetchImpl;
    const deps = createDependencies({
        fetchImpl: async url => {
            if (String(url).includes('champion.json')) return response({}, 503);
            return baseFetch(url);
        }
    });

    const result = await load(deps);

    assert.equal(result.data.level, validStats.level);
    assert.deepEqual(result.champMap, {});
    assert.equal(result.warnings[0].resource, 'Data Dragon Champion-Daten');
    assert.match(result.warnings[0].reason, /HTTP 503/);
});

test('retries a transient stats API failure once and then succeeds', async () => {
    let apiCalls = 0;
    const deps = createDependencies({
        fetchAPI: async () => {
            apiCalls++;
            if (apiCalls === 1) throw Object.assign(new Error('upstream failed'), { status: 503 });
            return structuredClone(validStats);
        }
    });

    const result = await load(deps);

    assert.equal(result.data.level, validStats.level);
    assert.equal(apiCalls, 2);
});

test('retries one transient network error', async () => {
    let apiCalls = 0;
    const deps = createDependencies({
        fetchAPI: async () => {
            apiCalls++;
            if (apiCalls === 1) throw new TypeError('Failed to fetch');
            return structuredClone(validStats);
        }
    });

    const result = await load(deps);

    assert.equal(result.data.level, validStats.level);
    assert.equal(apiCalls, 2);
});

test('reports the last HTTP 5xx after one retry fails', async () => {
    let apiCalls = 0;
    const deps = createDependencies({
        fetchAPI: async () => {
            apiCalls++;
            throw Object.assign(new Error('upstream failed'), { status: 503 });
        }
    });

    await assert.rejects(load(deps), error => {
        assert.ok(error instanceof LoLDataError);
        assert.equal(error.resource, 'Riot-Statistik-API');
        assert.equal(error.reason, 'HTTP 503');
        return true;
    });
    assert.equal(apiCalls, 2);
});

test('does not retry a non-transient stats API failure and identifies it', async () => {
    let apiCalls = 0;
    const deps = createDependencies({
        fetchAPI: async () => {
            apiCalls++;
            throw Object.assign(new Error('sensitive upstream body'), { status: 401 });
        }
    });

    await assert.rejects(load(deps), error => {
        assert.ok(error instanceof LoLDataError);
        assert.equal(error.resource, 'Riot-Statistik-API');
        assert.equal(error.reason, 'HTTP 401');
        const message = formatLoLLoadError(error);
        assert.match(message, /Riot-Statistik-API: HTTP 401/);
        assert.doesNotMatch(message, /sensitive upstream body/);
        return true;
    });
    assert.equal(apiCalls, 1);
});

test('does not retry a rate-limited stats API response', async () => {
    let apiCalls = 0;
    const deps = createDependencies({
        fetchAPI: async () => {
            apiCalls++;
            throw Object.assign(new Error('rate limited'), { status: 429 });
        }
    });

    await assert.rejects(load(deps), error => {
        assert.ok(error instanceof LoLDataError);
        assert.equal(error.reason, 'HTTP 429');
        return true;
    });
    assert.equal(apiCalls, 1);
});

test('maps a stats TimeoutError clearly without retrying', async () => {
    let apiCalls = 0;
    const deps = createDependencies({
        fetchAPI: async () => {
            apiCalls++;
            throw new DOMException('Request timed out', 'TimeoutError');
        }
    });

    await assert.rejects(load(deps), error => {
        assert.ok(error instanceof LoLDataError);
        assert.equal(error.reason, 'Zeitüberschreitung');
        return true;
    });
    assert.equal(apiCalls, 1);
});

test('preserves an already normalized LoL data error instead of wrapping it again', async () => {
    let apiCalls = 0;
    const upstreamError = new LoLDataError(
        'Riot-Proxy',
        Object.assign(new Error('upstream failed'), { status: 401 })
    );
    const deps = createDependencies({
        fetchAPI: async () => {
            apiCalls++;
            throw upstreamError;
        }
    });

    await assert.rejects(load(deps), error => error === upstreamError);
    assert.equal(apiCalls, 1);
});

test('rejects null, arrays, invalid levels and missing stats collections', async () => {
    const invalidPayloads = [
        null,
        [],
        { level: '44', masteryTop3: [], recentMatches: [] },
        { level: -1, masteryTop3: [], recentMatches: [] },
        { level: 44, masteryTop3: 'not an array', recentMatches: [] },
        { level: 44, masteryTop3: [], recentMatches: 'not an array' }
    ];

    for (const payload of invalidPayloads) {
        const deps = createDependencies({ fetchAPI: async () => payload });
        await assert.rejects(load(deps), error => {
            assert.ok(error instanceof LoLDataError);
            assert.equal(error.resource, 'Riot-Statistik-API');
            assert.equal(error.reason, 'Ungültiges Antwortformat');
            return true;
        });
    }
});

test('formats optional-source warnings without losing the successful stats', () => {
    const warning = formatLoLMetadataWarning([
        { resource: 'Data Dragon Champion-Daten', reason: 'HTTP 503' },
        { resource: 'Riot-Queue-Metadaten', reason: 'Netzwerkfehler' }
    ]);

    assert.match(warning, /Data Dragon Champion-Daten \(HTTP 503\), Riot-Queue-Metadaten \(Netzwerkfehler\)/);
    assert.match(warning, /Fallback-Bezeichnungen/);
    assert.equal(formatLoLMetadataWarning([]), '');
    assert.equal(
        formatLoLLoadError(new LoLDataError('Riot-Statistik-API', new TypeError('private detail'))),
        'Riot-Statistik-API: Netzwerkfehler. Bitte erneut versuchen.'
    );
    assert.equal(
        formatLoLLoadError(new LoLDataError('Riot-Statistik-API', new DOMException('deadline', 'TimeoutError'))),
        'Riot-Statistik-API: Zeitüberschreitung. Bitte erneut versuchen.'
    );
});

test('reports a missing stats request function as configuration failure', async () => {
    const deps = createDependencies();
    deps.fetchAPI = undefined;

    await assert.rejects(load(deps), error => {
        assert.ok(error instanceof LoLDataError);
        assert.equal(error.resource, 'LoL-Statistik-Loader');
        assert.equal(error.reason, 'Frontend-Konfiguration fehlerhaft');
        return true;
    });
});

test('propagates navigation abort without retrying', async () => {
    const controller = new AbortController();
    const calls = { api: 0 };
    controller.abort(new DOMException('Navigation changed', 'AbortError'));
    const deps = createDependencies({
        fetchImpl: async (_url, { signal }) => { throw signal.reason; },
        fetchAPI: async () => {
            calls.api++;
            throw controller.signal.reason;
        }
    });

    await assert.rejects(load(deps, { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(calls.api, 1);
});
