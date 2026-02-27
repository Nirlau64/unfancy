document.addEventListener("DOMContentLoaded", () => {
    const WORKER_URL = 'https://spotify-proxy.tools-309.workers.dev';

    const spotifyContainer = document.getElementById('spotify-container');
    const topArtistsListContainer = document.getElementById('top-artists-list-container');
    const chartsContainer = document.getElementById('charts-container');
    let topArtistsChartInstance = null;

    // Diese Funktion wird jetzt erst aufgerufen, NACHDEM Chart.js geladen ist.
    async function initialize() {
        await loadSpotifyData();
        setInterval(loadSpotifyData, 30000); // Aktualisierung alle 30s
    }

    async function fetchFromWorker(endpoint) {
        try {
            const cacheBuster = new Date().getTime();
            const response = await fetch(`${WORKER_URL}${endpoint}?t=${cacheBuster}`);
            if (!response.ok) throw new Error(`Worker-Anfrage fehlgeschlagen: ${response.status}`);
            return response.json();
        } catch (error) {
            console.error('Fehler beim Laden der Worker-Daten:', error);
            chartsContainer.innerHTML = `<p style="color: #ffcc00;">Fehler: Daten konnten nicht geladen werden.</p>`;
            return null;
        }
    }

    function renderNowPlaying(data) {
        // ... (unverändert)
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

    function renderTopArtists(data) {
        if (!data || !data.items || !data.items.length) {
            topArtistsListContainer.innerHTML = '<p>Top-Künstler konnten nicht geladen werden.</p>';
            chartsContainer.style.display = 'none';
            return;
        }
        const artists = data.items;
        const popularityAvailable = artists[0]?.popularity !== undefined;

        if (popularityAvailable) artists.sort((a, b) => b.popularity - a.popularity);
        else artists.sort((a, b) => a.name.localeCompare(b.name));

        let artistListHTML = '<h2>Top Künstler</h2><div class="artist-grid">';
        artists.forEach(artist => {
            const imageUrl = artist.images.find(img => img.width >= 160)?.url || artist.images[0]?.url;
            artistListHTML += `
                <a href="${artist.external_urls.spotify}" target="_blank" class="artist-card">
                    <img src="${imageUrl}" alt="${artist.name}">
                    <span>${artist.name}</span>
                    ${popularityAvailable ? `
                        <div class="popularity">
                            Popularität: ${artist.popularity}
                            <div class="popularity-bar">
                                <div class="popularity-fill" style="width: ${artist.popularity}%;"></div>
                            </div>
                        </div>
                    ` : ''}
                </a>
            `;
        });
        artistListHTML += '</div>';
        topArtistsListContainer.innerHTML = artistListHTML;

        if (!popularityAvailable) {
            chartsContainer.style.display = 'none';
            return;
        }

        chartsContainer.style.display = 'block';
        if (topArtistsChartInstance) topArtistsChartInstance.destroy();
        
        const ctx = document.getElementById('top-artists-chart').getContext('2d');
        topArtistsChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: artists.map(a => a.name),
                datasets: [{
                    label: 'Popularität',
                    data: artists.map(a => a.popularity),
                    backgroundColor: 'rgba(30, 215, 96, 0.6)',
                    borderColor: 'rgba(30, 215, 96, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { beginAtZero: true, max: 100, ticks: { color: 'rgba(255, 255, 255, 0.7)' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
                    y: { ticks: { color: 'rgba(255, 255, 255, 0.7)', font: { size: 10 } }, grid: { display: false } }
                }
            }
        });
    }

    async function loadSpotifyData() {
        const [nowPlayingData, topArtistsData] = await Promise.all([
            fetchFromWorker('/now-playing'),
            fetchFromWorker('/top-artists')
        ]);
        renderNowPlaying(nowPlayingData);
        renderTopArtists(topArtistsData);
    }

    // KORREKTUR: Zuerst das Skript laden, DANN initialisieren.
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
    script.onload = initialize; // Die Hauptlogik wird erst nach dem Laden von Chart.js gestartet.
    document.head.appendChild(script);
});
