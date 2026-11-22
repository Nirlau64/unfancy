#!/usr/bin/env node
/**
 * Builds static, crawlable deep-link pages (/<page>/index.html) from the
 * index.html shell and the pages/*.html fragments.
 *
 * Fails fast on missing or ambiguous markers so a changed shell cannot
 * silently produce broken metadata.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://nirlau.de';

const PAGES = {
    steam: {
        title: 'Unfancy - Steam Statistiken',
        description: 'Steam-Profil, meistgespielte Spiele und Gesamtspielzeit-Statistiken.',
    },
    spotify: {
        title: 'Unfancy - Spotify',
        description: 'Aktuell gehörte Musik, Top-Künstler und Top-Titel auf Spotify.',
    },
    lol: {
        title: 'Unfancy - League of Legends',
        description: 'Summoner-Statistiken, Top-Champions und Match-Historie für League of Legends.',
    },
    socials: {
        title: 'Unfancy - Socials',
        description: 'YouTube- und Instagram-Kanäle von Laurin.',
    },
};

function read(rel) {
    return readFileSync(join(ROOT, rel), 'utf8');
}

function mustOccurOnce(haystack, needle, label) {
    const count = haystack.split(needle).length - 1;
    if (count !== 1) {
        throw new Error(`${label} expected exactly once in shell, found ${count}`);
    }
}

const shell = read('index.html');

// Anchor markers must be unambiguous before we start cutting the shell apart.
mustOccurOnce(shell, '<main id="app-content">', 'main open tag');
mustOccurOnce(shell, '</main>', 'main close tag');
mustOccurOnce(shell, '<title>', 'title open tag');
mustOccurOnce(shell, '</title>', 'title close tag');
mustOccurOnce(shell, '<body>', 'body open tag');

const mainStart = shell.indexOf('<main id="app-content">');
const mainEnd = shell.indexOf('</main>', mainStart);
const mainOpen = shell.slice(mainStart, mainStart + '<main id="app-content">'.length);

for (const [page, meta] of Object.entries(PAGES)) {
    const fragment = read(join('pages', `${page}.html`));
    if (!fragment.includes(`id="${page}"`)) {
        throw new Error(`Fragment pages/${page}.html does not contain id="${page}"`);
    }

    let html = shell;

    // 1. Inject the fragment as the pre-rendered main content.
    const inner = fragment.trim();
    html = html.slice(0, mainStart) + `${mainOpen}\n${inner}\n        ` + html.slice(mainEnd);

    // 2. Unique metadata.
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${meta.title}</title>`);
    html = html.replace(
        /<meta name="description" content="[^"]*">/,
        `<meta name="description" content="${meta.description}">`
    );
    html = html.replace(
        /<meta property="og:title" content="[^"]*">/,
        `<meta property="og:title" content="${meta.title}">`
    );
    html = html.replace(
        /<meta property="og:description" content="[^"]*">/,
        `<meta property="og:description" content="${meta.description}">`
    );
    html = html.replace(
        /<meta property="og:url" content="[^"]*">/,
        `<meta property="og:url" content="${ORIGIN}/${page}/">`
    );
    html = html.replace(
        /<meta name="twitter:title" content="[^"]*">/,
        `<meta name="twitter:title" content="${meta.title}">`
    );
    html = html.replace(
        /<meta name="twitter:description" content="[^"]*">/,
        `<meta name="twitter:description" content="${meta.description}">`
    );
    html = html.replace(
        /<title>/,
        `<link rel="canonical" href="${ORIGIN}/${page}/">\n    <title>`
    );

    // 3. Mark the static page so tests and the router can detect it.
    html = html.replace('<body>', `<body data-static-page="${page}">`);

    // 4. Validate the result before writing.
    for (const [label, needle] of [
        ['canonical', `<link rel="canonical" href="${ORIGIN}/${page}/">`],
        ['static marker', `<body data-static-page="${page}">`],
        ['title', meta.title],
        ['description', meta.description],
    ]) {
        if (!html.includes(needle)) {
            throw new Error(`Validation failed for ${page}: missing ${label}`);
        }
    }
    const canonicalCount = (html.match(/rel="canonical"/g) || []).length;
    if (canonicalCount !== 1) {
        throw new Error(`Validation failed for ${page}: ${canonicalCount} canonical links`);
    }

    const outDir = join(ROOT, page);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'index.html'), html);
    console.log(`built /${page}/index.html (${html.length} bytes)`);
}
