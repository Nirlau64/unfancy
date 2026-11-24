#!/usr/bin/env node
// Test-only response mutation: a cold-document violation must survive reloads.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, ['scripts/e2e-browser.mjs', '--csp-negative-control', ...process.argv.slice(2)], {
  cwd: root, encoding: 'utf8', timeout: 90000,
});
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
assert.equal(result.error, undefined, 'negative control must execute without infrastructure errors');
assert.equal(result.status, 1, 'removed Steam host must fail the browser run');
assert.ok(output.includes('E2E assertion failed: no Content-Security-Policy violations across documents:'), output);
assert.ok(output.includes('connect-src'), 'failure must retain the earlier connect-src violation');
assert.ok(!output.includes('E2E timeout waiting for'), 'timeout is not a valid negative control');
console.log('CSP negative control PASS: removed Steam host detected across document changes; no source files changed.');
