/**
 * View Controller: Spotify
 */
import { fetchAPI } from '../api.js';
import { CONFIG, getDominantColor, updateAccentColor, setupSplashHover, preloadImages, renderError } from '../utils.js';

export async function initSpotify(signal = null) {
    const btns = document.querySelectorAll('.time-range-buttons button');
    if (!btns.length) return;
    
    // Use a WeakMap or a flag to prevent multiple listeners if re-initialized
    // But since buttons are part of #app-content and replaced, it's usually safe.
    btns.forEach(b => b.addEventListener('click', (e) => {
        btns.forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
        loadSpotifyData(e.target.dataset.range, signal);
    }));

    loadSpotifyData('medium_term', signal);
}

async function loadSpotifyData(range, signal = null) {
    const artistsDiv = document.getElementById('spotify-artists');
    const tracksDiv = document.getElementById('spotify-tracks');
    const nowPlayingDiv = document.getElementById('spotify-now-playing');
    if (!artistsDiv || !tracksDiv) return;

    // Show loading indicators with A11y
    renderLoading(artistsDiv, 'Meine Top Künstler');
    renderLoading(tracksDiv, 'Meine Top Titel');

    try {
        const [artists, tracks, nowPlaying] = await Promise.all([
            fetchAPI(`${CONFIG.API.SPOTIFY}/top-artists?range=${range}`, false, signal),
            fetchAPI(`${CONFIG.API.SPOTIFY}/top-tracks?range=${range}`, false, signal),
            fetchAPI(`${CONFIG.API.SPOTIFY}/now-playing`, true, signal).catch(() => null)
        ]);

        if (signal?.aborted) return;

        if (nowPlayingDiv) nowPlayingDiv.style.display = 'none';
        if (nowPlaying?.is_playing) {
            const color = await getDominantColor(nowPlaying.item.album.images[0].url);
            if (signal?.aborted) return;
            updateAccentColor(color);
        }

        renderArtists(artistsDiv, artists?.items || []);
        renderTracks(tracksDiv, tracks?.items || []);

    } catch(e) {
        if (e.name === 'AbortError') return;
        console.error("Spotify loading error", e);
        renderError(artistsDiv, "Spotify-Daten konnten nicht geladen werden.", () => loadSpotifyData(range, signal));
    }
}

function renderLoading(container, title) {
    while (container.firstChild) container.removeChild(container.firstChild);
    
    const h2 = document.createElement('h2');
    h2.textContent = title;
    container.appendChild(h2);

    const loader = document.createElement('div');
    loader.className = 'text-center text-muted';
    loader.setAttribute('aria-live', 'polite');
    loader.textContent = 'Lade...';
    container.appendChild(loader);
}

function renderArtists(container, items) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add('section-relative');

    preloadImages(items.map(a => a.images[0]?.url));

    const splashBg = document.createElement('div');
    splashBg.className = 'splash-bg';
    container.appendChild(splashBg);

    const content = document.createElement('div');
    content.className = 'splash-content';

    const h2 = document.createElement('h2');
    h2.textContent = 'Meine Top Künstler';
    content.appendChild(h2);

    const grid = document.createElement('div');
    grid.className = 'media-grid';

    items.forEach(a => {
        const card = document.createElement('a');
        card.href = a.external_urls.spotify;
        card.target = '_blank';
        card.className = 'media-card artist';
        card.dataset.splash = a.images[0]?.url || '';

        const img = document.createElement('img');
        img.src = a.images[0]?.url || '';
        img.alt = a.name;
        card.appendChild(img);

        const span = document.createElement('span');
        span.textContent = a.name;
        card.appendChild(span);

        grid.appendChild(card);
    });

    content.appendChild(grid);
    container.appendChild(content);
    setupSplashHover(container, '.media-card', '.splash-bg');
}

function renderTracks(container, items) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add('section-relative');

    preloadImages(items.map(t => t.album.images[0]?.url));

    const splashBg = document.createElement('div');
    splashBg.className = 'splash-bg';
    container.appendChild(splashBg);

    const content = document.createElement('div');
    content.className = 'splash-content';

    const h2 = document.createElement('h2');
    h2.textContent = 'Meine Top Titel';
    content.appendChild(h2);

    const grid = document.createElement('div');
    grid.className = 'media-grid';

    items.forEach(t => {
        const card = document.createElement('a');
        card.href = t.external_urls.spotify;
        card.target = '_blank';
        card.className = 'media-card track';
        card.dataset.splash = t.album.images[0]?.url || '';

        const img = document.createElement('img');
        img.src = t.album.images[0]?.url || '';
        img.alt = t.name;
        card.appendChild(img);

        const title = document.createElement('span');
        title.textContent = t.name;
        card.appendChild(title);

        const artists = document.createElement('span');
        artists.className = 'artist-name';
        artists.textContent = t.artists.map(ar => ar.name).join(', ');
        card.appendChild(artists);

        grid.appendChild(card);
    });

    content.appendChild(grid);
    container.appendChild(content);
    setupSplashHover(container, '.media-card', '.splash-bg');
}
