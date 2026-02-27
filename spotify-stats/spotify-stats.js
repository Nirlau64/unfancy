document.addEventListener("DOMContentLoaded", () => {
    const WORKER_URL = 'https://spotify-proxy.tools-309.workers.dev';

    const spotifyContainer = document.getElementById('spotify-container');
    // HINWEIS: Das Element wird von 'charts-container' in 'top-artists-container' umbenannt
    const topArtistsContainer = document.getElementById('top-artists-container'); 
    
    async function fetchFromWorker(endpoint) {
        try {
            const response = await fetch(`${WORKER_URL}${endpoint}`);
            if (!response.ok) throw new Error(`Worker request failed: ${response.status}`);
            if (response.status === 204) return null;
            return response.json();
        } catch (error) {
            console.error('Error fetching from worker:', error);
            return null;
        }
    }

    function renderNowPlaying(data) {
        let content = '';
        if (data && data.is_playing) {
            const track = data.item;
            content = `
                <h3>Aktuell läuft:</h3>
                <div class="track">
                    <img src="${track.album.images[0].url}" alt="Album Cover" width="64" height="64">
                    <div class="track-info">
                        <strong>${track.name}</strong>
                        <span>${track.artists.map(a => a.name).join(', ')}</span>
                    </div>
                </div>
            `;
        } else {
            content = '<p>Momentan spielt kein Song.</p>';
        }
        spotifyContainer.innerHTML = content;
    }

    // NEU: Diese Funktion erstellt eine Liste statt einer Grafik
    function renderTopArtistsList(data) {
        if (!data || !data.items || data.items.length === 0) {
            topArtistsContainer.innerHTML = '<p>Konnte keine Top-Künstler laden.</p>';
            return;
        }

        // Erstelle die HTML-Struktur für die Künstlerliste
        let artistListHTML = '<h2>Top Künstler</h2><div class="artist-grid">';

        data.items.forEach(artist => {
            // Wähle das kleinste Bild, das nicht zu winzig ist (z.B. 160px)
            const imageUrl = artist.images.find(img => img.width >= 160)?.url || artist.images[0]?.url;

            artistListHTML += `
                <a href="${artist.external_urls.spotify}" target="_blank" class="artist-card">
                    <img src="${imageUrl}" alt="${artist.name}">
                    <span>${artist.name}</span>
                </a>
            `;
        });

        artistListHTML += '</div>';
        topArtistsContainer.innerHTML = artistListHTML;
    }

    async function loadSpotifyData() {
        const nowPlayingData = await fetchFromWorker('/now-playing');
        renderNowPlaying(nowPlayingData);

        const topArtistsData = await fetchFromWorker('/top-artists');
        // Rufe die neue Funktion auf
        renderTopArtistsList(topArtistsData);
    }

    loadSpotifyData();
    setInterval(loadSpotifyData, 30000); 
});
