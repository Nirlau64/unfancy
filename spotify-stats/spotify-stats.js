document.addEventListener("DOMContentLoaded", () => {
    const WORKER_URL = 'https://spotify-proxy.tools-309.workers.dev';

    const spotifyContainer = document.getElementById('spotify-container');
    const topArtistsListContainer = document.getElementById('top-artists-list-container');
    const topTracksListContainer = document.getElementById('top-tracks-list-container');

    async function initialize() {
        if (!spotifyContainer || !topArtistsListContainer || !topTracksListContainer) {
            console.error("One or more required containers are missing from the DOM.");
            return;
        }
        await loadSpotifyData();
        setInterval(loadSpotifyData, 30000);
    }

    async function fetchFromWorker(endpoint) {
        try {
            const cacheBuster = new Date().getTime();
            const response = await fetch(`${WORKER_URL}${endpoint}?t=${cacheBuster}`);
            if (!response.ok) {
                throw new Error(`Worker-Anfrage fehlgeschlagen: ${response.status}`);
            }
            return response.json();
        } catch (error) {
            console.error('Fehler beim Laden der Worker-Daten:', error);
            if (spotifyContainer) {
                spotifyContainer.innerHTML = `<p style="color: #ffcc00; text-align: center;">Fehler: Daten konnten nicht geladen werden.</p>`;
            }
            return null;
        }
    }

    function renderNowPlaying(data) {
        if (!spotifyContainer) return;
        let content = '';
        if (data && data.is_playing) {
            const track = data.item;
            content = `
                <div class="track">
                    <img src="${track.album.images[0].url}" alt="Album Cover">
                    <div class="track-info">
                        <strong>${track.name}</strong>
                        <span>${track.artists.map(a => a.name).join(', ')}</span>
                    </div>
                </div>
            `;
        } else {
            content = '<p style="text-align: center;">Momentan spielt kein Song.</p>';
        }
        spotifyContainer.innerHTML = content;
    }

    function renderTopArtists(data) {
        if (!topArtistsListContainer) return;
        if (!data || !data.items || !data.items.length) {
            topArtistsListContainer.innerHTML = '<p style="text-align: center;">Top-Künstler konnten nicht geladen werden.</p>';
            return;
        }
        const artists = data.items;
        let artistListHTML = '<h2>Meine Top Künstler</h2><div class="artist-grid">';
        artists.forEach(artist => {
            const imageUrl = artist.images.find(img => img.width >= 160)?.url || artist.images[0]?.url;
            artistListHTML += `
                <a href="${artist.external_urls.spotify}" target="_blank" class="artist-card">
                    <img src="${imageUrl}" alt="${artist.name}">
                    <span>${artist.name}</span>
                </a>
            `;
        });
        artistListHTML += '</div>';
        topArtistsListContainer.innerHTML = artistListHTML;
    }

    function renderTopTracks(data) {
        if (!topTracksListContainer) return;
        if (!data || !data.items || !data.items.length) {
            topTracksListContainer.innerHTML = '<p style="text-align: center;">Top-Titel konnten nicht geladen werden.</p>';
            return;
        }
        const tracks = data.items;
        let trackListHTML = '<h2>Meine Top Titel</h2><div class="track-grid">';
        tracks.forEach(track => {
            const imageUrl = track.album.images.find(img => img.width >= 160)?.url || track.album.images[0]?.url;
            trackListHTML += `
                <a href="${track.external_urls.spotify}" target="_blank" class="track-card">
                    <img src="${imageUrl}" alt="${track.name}">
                    <span>${track.name}</span>
                    <span class="artist-name">${track.artists.map(a => a.name).join(', ')}</span>
                </a>
            `;
        });
        trackListHTML += '</div>';
        topTracksListContainer.innerHTML = trackListHTML;
    }

    async function loadSpotifyData() {
        const [nowPlayingData, topArtistsData, topTracksData] = await Promise.all([
            fetchFromWorker('/now-playing'),
            fetchFromWorker('/top-artists'),
            fetchFromWorker('/top-tracks')
        ]);
        renderNowPlaying(nowPlayingData);
        renderTopArtists(topArtistsData);
        renderTopTracks(topTracksData);
    }

    initialize();
});