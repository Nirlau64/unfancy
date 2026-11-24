#!/usr/bin/env node
/**
 * Reusable mutant ("test-the-test") runner for the browser regression.
 *
 * Proves that scripts/e2e-browser.mjs actually tests what it claims:
 *   1. BASELINE: the unmutated repository passes the full browser regression.
 *   2. MUTANT: the exact cache-poisoning mutation — an unconditional
 *        preCachePage('home', document.getElementById('app-content').innerHTML)
 *      right before `getPageFromURL()` in js/main.js (the insertion a reviewer
 *      made while auditing this suite) — must FAIL with the SPECIFIC
 *      home-content-mismatch assertion, not a timeout or infra error.
 *
 * The mutation is applied to a scratch copy of js/main.js and restored in a
 * `finally` block; the repository working tree is never left mutated.
 *
 * Run with: node scripts/e2e-mutant.mjs [--browser /path/to/chrome]
 * Exit code 0 only if BOTH runs behave as specified.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(ROOT, 'js', 'main.js');
const ORIGINAL = readFileSync(MAIN, 'utf8');

const TARGET = '    const requestedPage = getPageFromURL();';
const MUTATION = `    preCachePage('home', document.getElementById('app-content').innerHTML);\n${TARGET}`;

if (!ORIGINAL.includes(TARGET)) {
  console.error('mutant runner: insertion point not found — refusing to run against an unexpected js/main.js');
  process.exit(2);
}

const SPECIFIC_FAILURE = 'Home shows the real home fragment (home-title present), not a poisoned cache';
// Failure signatures that indicate a timeout/infra problem instead of a
// genuine, specific detection of the mutation.
const INFRA_ERRORS = ['chrome did not expose a DevTools socket', 'chrome exited early', 'E2E timeout waiting for'];

async function runE2E(browserArgs, label) {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/e2e-browser.mjs', ...browserArgs], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out, label });
    });
  });
}

function report(run) {
  console.log(`--- ${run.label}: exit ${run.code}`);
  const tail = run.output.trim().split('\n').slice(-4).join('\n');
  console.log(tail);
}

let result = 0;
let mutant;
try {
  const browserIdx = process.argv.indexOf('--browser');
  const browserArgs = browserIdx !== -1 ? ['--browser', process.argv[browserIdx + 1]] : [];

  const baseline = await runE2E(browserArgs, 'BASELINE (unmutated)');
  report(baseline);
  if (baseline.code !== 0 || !baseline.output.includes('all assertions passed')) {
    console.error(`mutant runner: FAIL — baseline must pass`);
    result = 1;
  }

  console.log(`mutant: applying cache-poisoning mutation to js/main.js`);
  writeFileSync(MAIN, ORIGINAL.replace(TARGET, MUTATION, 1));
  mutant = await runE2E(browserArgs, 'MUTANT (unconditional home pre-cache)');
  report(mutant);
} finally {
  writeFileSync(MAIN, ORIGINAL);
  execFileSync('git', ['status', '--short', '--', 'js/main.js'], { cwd: ROOT });
}

if (!mutant) process.exit(result || 1);

const failedSpecifically = mutant.code !== 0
  && mutant.output.includes(`E2E assertion failed: ${SPECIFIC_FAILURE}`)
  && !INFRA_ERRORS.some((sig) => mutant.output.includes(sig));

if (!failedSpecifically) {
  console.error('mutant runner: FAIL — the mutation was not detected with the specific home-content mismatch '
    + '(a green run means the regression suite is blind; an infra error means the run is not trustworthy)');
  result = 1;
} else {
  console.log('mutant runner: mutation detected via the specific home-content assertion ✓');
}

console.log(result === 0
  ? 'mutant runner: PASS — baseline green, cache-poisoning mutant fails with the specific assertion'
  : 'mutant runner: FAILED');
process.exit(result);
