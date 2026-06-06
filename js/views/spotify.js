/**
 * View Controller: Spotify
 */
import { fetchAPI } from '../api.js';
import { CONFIG, getDominantColor, updateAccentColor, setupSplashHover, preloadImages, renderError, getRelativeTime, renderSkeleton } from '../utils.js';

let spotifyAbortController = null;

export async function initSpotify(signal = null) {
    const btns = document.querySelectorAll('.time-range-buttons button');
    if (!btns.length) return;
    
    // Use a WeakMap or a flag to prevent multiple listeners if re-initialized
    // But since buttons are part of #app-content and replaced, it's usually safe.
    btns.forEach(b => b.addEventListener('click', (e) => {
        btns.forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
        // Abort previous data load on rapid tab switches
        if (spotifyAbortController) spotifyAbortController.abort();
        spotifyAbortController = new AbortController();
        loadSpotifyData(e.target.dataset.range, spotifyAbortController.signal);
    }));

    spotifyAbortController = new AbortController();
    loadSpotifyData('medium_term', spotifyAbortController.signal);
}

async function loadSpotifyData(range, signal = null) {
    const artistsDiv = document.getElementById('spotify-artists');
    const tracksDiv = document.getElementById('spotify-tracks');
    const nowPlayingDiv = document.getElementById('spotify-now-playing');
    if (!artistsDiv || !tracksDiv) return;

    // Show skeleton loaders
    renderSkeleton(artistsDiv, 'grid', 8);
    renderSkeleton(tracksDiv, 'grid', 8);

    const fetchTime = Date.now();

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

        renderArtists(artistsDiv, artists?.items || [], fetchTime);
        renderTracks(tracksDiv, tracks?.items || [], fetchTime);

    } catch(e) {
        if (e.name === 'AbortError') return;
        console.error("Spotify loading error", e);
        renderError(artistsDiv, "Spotify-Daten konnten nicht geladen werden.", () => loadSpotifyData(range, signal));
    }
}

function renderArtists(container, items, fetchTime) {
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
        card.rel = 'noopener noreferrer';
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
    
    if (fetchTime) {
        const timeP = document.createElement('p');
        timeP.className = 'text-center text-muted';
        timeP.style.marginTop = '15px';
        timeP.style.fontSize = '0.8em';
        timeP.textContent = `Zuletzt aktualisiert: ${getRelativeTime(fetchTime)}`;
        content.appendChild(timeP);
    }

    container.appendChild(content);
    setupSplashHover(container, '.media-card', '.splash-bg');
}

function renderTracks(container, items, fetchTime) {
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
        card.rel = 'noopener noreferrer';
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
    
    if (fetchTime) {
        const timeP = document.createElement('p');
        timeP.className = 'text-center text-muted';
        timeP.style.marginTop = '15px';
        timeP.style.fontSize = '0.8em';
        timeP.textContent = `Zuletzt aktualisiert: ${getRelativeTime(fetchTime)}`;
        content.appendChild(timeP);
    }

    container.appendChild(content);
    setupSplashHover(container, '.media-card', '.splash-bg');
}
