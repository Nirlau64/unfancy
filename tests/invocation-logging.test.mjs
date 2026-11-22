import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { logInvocation, redactPath } from '../workers/invocation-logging.js';

 test('omits all query data from logged paths, including unknown parameter names', () => {
  const result = redactPath('https://worker.example/callback?token=TOPSECRET&api_key=KEYSECRET&range=short&state=STATESECRET');
  assert.equal(result, '/callback');
  assert.equal(redactPath('https://worker.example/path?customCredential=TOPSECRET'), '/path');
  assert.doesNotMatch(result, /TOPSECRET|KEYSECRET|STATESECRET/);
});

test('logs invocation metadata and never logs query secrets', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    const response = await logInvocation(new Request('https://worker.example/a?key=VERYSECRET'), async () => new Response('ok', { status: 201 }));
    assert.equal(response.status, 201);
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.method, 'GET');
  assert.equal(record.path, '/a');
  assert.equal(record.status, 201);
  assert.equal(typeof record.timestamp, 'string');
  assert.equal(typeof record.durationMs, 'number');
  assert.doesNotMatch(lines[0], /VERYSECRET/);
});

test('logging configuration sets 30-day retention', async () => {
  const config = JSON.parse(await readFile(new URL('../workers/logging.config.json', import.meta.url), 'utf8'));
  assert.equal(config.retentionDays, 30);
  assert.ok(config.redactedQueryParameters.includes('api_key'));
});
