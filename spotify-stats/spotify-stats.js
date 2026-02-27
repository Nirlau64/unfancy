document.addEventListener("DOMContentLoaded", () => {
    const WORKER_URL = 'https://spotify-proxy.tools-309.workers.dev';

    const spotifyContainer = document.getElementById('spotify-container');
    const topArtistsListContainer = document.getElementById('top-artists-list-container');
    const chartsContainer = document.getElementById('charts-container');
    let topArtistsChartInstance = null;

    async function fetchFromWorker(endpoint) {
        try {
            const response = await fetch(`${WORKER_URL}${endpoint}`);
            if (!response.ok) throw new Error(`Worker-Anfrage fehlgeschlagen: ${response.status}`);
            if (response.status === 204) return null;
            return response.json();
        } catch (error) {
            console.error('Fehler beim Laden der Worker-Daten:', error);
            chartsContainer.innerHTML = `<p style="color: #ffcc00;">Fehler: Daten konnten nicht geladen werden.</p>`;
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

    function renderTopArtists(data) {
        if (!data || !data.items || data.items.length === 0) {
            topArtistsListContainer.innerHTML = '<p>Top-Künstler konnten nicht geladen werden.</p>';
            chartsContainer.style.display = 'none';
            return;
        }

        const artists = data.items;

        // SORTIERUNG: Primär nach Popularität (absteigend), sekundär alphabetisch.
        const popularityAvailable = artists[0].popularity !== undefined;
        if (popularityAvailable) {
            artists.sort((a, b) => b.popularity - a.popularity);
        } else {
            artists.sort((a, b) => a.name.localeCompare(b.name));
        }

        // 1. KACHEL-LISTE RENDERN
        let artistListHTML = '<h2>Top Künstler</h2><div class="artist-grid">';
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

        // 2. BALKENGRAFIK RENDERN (nur wenn Popularität vorhanden)
        if (!popularityAvailable) {
            chartsContainer.style.display = 'none'; // Grafik ausblenden, wenn keine Daten da sind
            return;
        }

        chartsContainer.style.display = 'block';
        if (topArtistsChartInstance) {
            topArtistsChartInstance.destroy();
        }
        const ctx = document.getElementById('top-artists-chart').getContext('2d');
        
        // Wichtig: Labels und Daten aus den BEREITS SORTIERTEN Künstlern nehmen
        const labels = artists.map(artist => artist.name);
        const popularityData = artists.map(artist => artist.popularity);

        topArtistsChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Popularität',
                    data: popularityData,
                    backgroundColor: 'rgba(30, 215, 96, 0.6)',
                    borderColor: 'rgba(30, 215, 96, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                indexAxis: 'y',
                scales: {
                    x: { beginAtZero: true, max: 100, ticks: { color: 'rgba(255, 255, 255, 0.7)' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
                    y: { ticks: { color: 'rgba(255, 255, 255, 0.7)', font: { size: 10 } }, grid: { display: false } }
                },
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } }
            }
        });
    }

    async function loadSpotifyData() {
        const nowPlayingData = await fetchFromWorker('/now-playing');
        renderNowPlaying(nowPlayingData);

        const topArtistsData = await fetchFromWorker('/top-artists');
        renderTopArtists(topArtistsData); // Neue, kombinierte Funktion aufrufen
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
    script.onload = () => {
        loadSpotifyData();
        setInterval(loadSpotifyData, 30000);
    };
    document.head.appendChild(script);
});
