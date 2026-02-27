document.addEventListener("DOMContentLoaded", () => {
    // ---- KONFIGURATION ----
    const WORKER_URL = 'https://spotifystats.tools-309.workers.dev'; 
    // ---------------------

    const spotifyContainer = document.getElementById('spotify-container');
    const chartsContainer = document.getElementById('charts-container');

    async function fetchFromWorker(endpoint) {
        try {
            const response = await fetch(`${WORKER_URL}${endpoint}`);
            if (!response.ok) {
                throw new Error(`Worker request failed with status ${response.status}`);
            }
            if (response.status === 204) {
                return null;
            }
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
                    <img src="${track.album.images[0].url}" alt="Album Cover" width="100" height="100">
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
    
    function renderTopArtistsChart(data) {
        if (!data || !data.items || data.items.length === 0) {
            chartsContainer.innerHTML = '<p>Konnte keine Top-Künstler laden.</p>';
            return;
        }

        const ctx = document.getElementById('top-artists-chart').getContext('2d');
        
        const labels = data.items.map(artist => artist.name);
        const popularityData = data.items.map(artist => artist.popularity);

        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Popularität auf Spotify',
                    data: popularityData,
                    backgroundColor: 'rgba(30, 215, 96, 0.6)',
                    borderColor: 'rgba(30, 215, 96, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                indexAxis: 'y',
                scales: {
                    x: {
                        beginAtZero: true,
                        max: 100, // FIX: Skala von 0-100 erzwingen
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.7)' // STYLE: Helle Schrift für Achsenbeschriftung
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)' // STYLE: Helle Gitterlinien
                        }
                    },
                    y: {
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.7)' // STYLE: Helle Schrift für Achsenbeschriftung
                        },
                        grid: {
                            display: false
                        }
                    }
                },
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                }
            }
        });
    }

    async function loadSpotifyData() {
        const nowPlayingData = await fetchFromWorker('/now-playing');
        renderNowPlaying(nowPlayingData);

        const topArtistsData = await fetchFromWorker('/top-artists');
        renderTopArtistsChart(topArtistsData);
    }

    loadSpotifyData();
    setInterval(loadSpotifyData, 30000); 
});
