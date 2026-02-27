document.addEventListener('DOMContentLoaded', function() {
    console.log('Welcome to Unfancy!');

    const spotifyStatusContainer = document.getElementById('spotify-status');
    const steamStatusContainer = document.getElementById('steam-status');
    const SPOTIFY_WORKER_URL = 'https://spotify.api.nirlau.de';
    const STEAM_WORKER_URL = 'https://steam.api.nirlau.de';
    const STEAMID = "76561198159661156"; // Your SteamID

    async function fetchFromWorker(url) {
        try {
            const cacheBuster = new Date().getTime();
            // Append cache buster correctly
            const finalUrl = url.includes('?') ? `${url}&t=${cacheBuster}` : `${url}?t=${cacheBuster}`;
            const response = await fetch(finalUrl);
            if (!response.ok) {
                throw new Error(`Worker request failed: ${response.status}`);
            }
            return response.json();
        } catch (error) {
            console.error('Error loading data from worker:', error);
            return null;
        }
    }

    async function loadSpotifyStatus() {
        if (!spotifyStatusContainer) return;

        const data = await fetchFromWorker(`${SPOTIFY_WORKER_URL}/now-playing`);
        
        let content = '';
        if (data && data.is_playing) {
            const track = data.item;
            content = `
                <div class="live-status-item">
                    <p>🎧 Laurin hört gerade:</p>
                    <div class="track">
                        <img src="${track.album.images[0].url}" alt="Album Cover">
                        <div class="track-info">
                            <strong>${track.name}</strong>
                            <span>${track.artists.map(a => a.name).join(', ')}</span>
                        </div>
                    </div>
                </div>
            `;
        }
        spotifyStatusContainer.innerHTML = content;
    }

    async function loadSteamStatus() {
        if (!steamStatusContainer) return;

        const data = await fetchFromWorker(`${STEAM_WORKER_URL}/currently-playing?steamid=${STEAMID}`);
        
        let content = '';
        if (data && data.game) {
            content = `
                <div class="live-status-item">
                    <p>🎮 Laurin spielt gerade:</p>
                    <div class="game">
                        <strong>${data.game}</strong>
                    </div>
                </div>
            `;
        }
        steamStatusContainer.innerHTML = content;
    }

    function loadLiveStatus() {
        loadSpotifyStatus();
        loadSteamStatus();
    }

    loadLiveStatus();
    setInterval(loadLiveStatus, 30000);
});
