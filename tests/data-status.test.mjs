import assert from 'node:assert/strict';
import test from 'node:test';
import { APIError, DataStatus, DataStatusSource, combineDataStatus, fetchAPI, STALE_CACHE_MARK } from '../js/api.js';

function abortedError() {
    const e = new Error('aborted');
    e.name = 'AbortError';
    return e;
}

test('fresh: successful load returns data, fetchTime and status fresh', async () => {
    const source = new DataStatusSource(async () => ({ value: 42 }));
    const result = await source.load();

    assert.equal(result.status, DataStatus.FRESH);
    assert.deepEqual(result.data, { value: 42 });
    assert.equal(typeof result.fetchTime, 'number');
    assert.equal(result.error, null);
});

test('stale: after a successful load, a failed refresh falls back to cached data', async () => {
    let payload = { value: 1 };
    const source = new DataStatusSource(async () => {
        if (payload === null) throw new APIError('upstream down', 502, null);
        return payload;
    });

    const first = await source.load();
    assert.equal(first.status, DataStatus.FRESH);
    const fetchTime = first.fetchTime;

    payload = null;
    const second = await source.load();

    assert.equal(second.status, DataStatus.STALE);
    assert.deepEqual(second.data, { value: 1 });
    assert.equal(second.fetchTime, fetchTime);
    assert.ok(second.error instanceof APIError);
    assert.equal(second.error.status, 502);
});

test('error: without cached data a failed load resolves with status error and no data', async () => {
    const source = new DataStatusSource(async () => {
        throw new APIError('boom', 500, null);
    });

    const result = await source.load();

    assert.equal(result.status, DataStatus.ERROR);
    assert.equal(result.data, null);
    assert.equal(result.fetchTime, null);
    assert.ok(result.error instanceof APIError);
});

test('AbortError is re-thrown and does not corrupt the cache', async () => {
    const source = new DataStatusSource(async () => {
        throw abortedError();
    });

    await assert.rejects(() => source.load(), (e) => e.name === 'AbortError');

    // Cache still empty: subsequent non-abort failure must be an error, not stale.
    const failing = new DataStatusSource(async () => { throw new Error('boom'); });
    const result = await failing.load();
    assert.equal(result.status, DataStatus.ERROR);
});

test('stale cache is not filled by failed loads', async () => {
    let shouldFail = true;
    const source = new DataStatusSource(async () => {
        if (shouldFail) throw new Error('boom');
        return 'ok';
    });

    assert.equal((await source.load()).status, DataStatus.ERROR);

    shouldFail = false;
    assert.equal((await source.load()).status, DataStatus.FRESH);
    assert.deepEqual(source.lastData, 'ok');
});

test('combineDataStatus: error beats stale beats fresh', () => {
    const fresh = { status: DataStatus.FRESH, data: 1, fetchTime: 1, error: null };
    const stale = { status: DataStatus.STALE, data: 1, fetchTime: 1, error: new Error('x') };
    const error = { status: DataStatus.ERROR, data: null, fetchTime: null, error: new Error('x') };

    assert.equal(combineDataStatus([fresh, fresh]), DataStatus.FRESH);
    assert.equal(combineDataStatus([fresh, stale]), DataStatus.STALE);
    assert.equal(combineDataStatus([stale, stale]), DataStatus.STALE);
    assert.equal(combineDataStatus([fresh, error]), DataStatus.ERROR);
    assert.equal(combineDataStatus([stale, error]), DataStatus.ERROR);
    assert.equal(combineDataStatus([]), DataStatus.FRESH);
});

test('fetchAPI tags payloads served with X-Unfancy-Cache: stale', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ value: 'cached' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Unfancy-Cache': 'stale' }
    });
    try {
        const data = await fetchAPI('https://example.test/api');
        assert.equal(data.value, 'cached');
        assert.equal(data[STALE_CACHE_MARK], true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('fetchAPI does not tag fresh responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ value: 'live' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
    try {
        const data = await fetchAPI('https://example.test/api');
        assert.equal(data[STALE_CACHE_MARK], undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DataStatusSource reports a cache-marked payload as stale with error null', async () => {
    const payload = { value: 'cached' };
    payload[STALE_CACHE_MARK] = true;
    const source = new DataStatusSource(async () => payload);

    const result = await source.load();

    assert.equal(result.status, DataStatus.STALE);
    assert.equal(result.data.value, 'cached');
    assert.equal(result.error, null);
    assert.equal(typeof result.fetchTime, 'number');

    // The cache-marked payload is still stored, so a later hard failure
    // degrades to stale as usual.
    const failing = new DataStatusSource(async () => {
        throw new APIError('down', 502, null);
    });
    await failing.load().catch(() => {});
    assert.equal(failing.lastData, null);
});

test('DataStatusSource stays fresh for unmarked payloads and keeps the mark out of JSON', async () => {
    const payload = { value: 'live' };
    const source = new DataStatusSource(async () => payload);

    const result = await source.load();

    assert.equal(result.status, DataStatus.FRESH);
    assert.equal(JSON.stringify(payload), '{"value":"live"}');
});
