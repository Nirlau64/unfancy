document.addEventListener("DOMContentLoaded", () => {
    const WORKER_URL = 'https://spotify.api.nirlau.de';

    const spotifyContainer = document.getElementById('spotify-container');
    const topArtistsListContainer = document.getElementById('top-artists-list-container');
    const topTracksListContainer = document.getElementById('top-tracks-list-container');
    const timeRangeButtons = document.querySelectorAll('.time-range-buttons button');

    async function initialize() {
        if (!spotifyContainer || !topArtistsListContainer || !topTracksListContainer) {
            console.error("One or more required containers are missing from the DOM.");
            return;
        }

        // Load Now Playing data and set an interval for it
        loadNowPlaying();
        setInterval(loadNowPlaying, 30000);

        // Load initial top items with the default time range ('medium_term')
        await loadTopItems('medium_term');

        // Add click event listeners to the time range buttons
        timeRangeButtons.forEach(button => {
            button.addEventListener('click', () => {
                // Remove 'active' class from all buttons
                timeRangeButtons.forEach(btn => btn.classList.remove('active'));
                // Add 'active' class to the clicked button
                button.classList.add('active');
                
                const timeRange = button.dataset.range;
                loadTopItems(timeRange);
            });
        });
    }

    async function fetchFromWorker(endpoint) {
        try {
            const cacheBuster = new Date().getTime();
            const response = await fetch(`${WORKER_URL}${endpoint}&t=${cacheBuster}`);
            if (!response.ok) {
                throw new Error(`Worker request failed: ${response.status}`);
            }
            return response.json();
        } catch (error) {
            console.error('Error loading data from worker:', error);
            // Display a generic error in the main container if the fetch fails
            if (spotifyContainer) {
                spotifyContainer.innerHTML = `<p style="color: #ffcc00; text-align: center;">Error: Could not load data.</p>`;
            }
            return null;
        }
    }
    
    async function loadNowPlaying() {
        const nowPlayingData = await fetchFromWorker('/now-playing?');
        renderNowPlaying(nowPlayingData);
    }

    async function loadTopItems(timeRange) {
        // Display loading messages while fetching data
        topArtistsListContainer.innerHTML = '<h2>Meine Top Künstler</h2><p style="text-align: center;">Lade Top-Künstler...</p>';
        topTracksListContainer.innerHTML = '<h2>Meine Top Titel</h2><p style-align: center;>Lade Top-Titel...</p>';

        const [topArtistsData, topTracksData] = await Promise.all([
            fetchFromWorker(`/top-artists?range=${timeRange}`),
            fetchFromWorker(`/top-tracks?range=${timeRange}`)
        ]);

        renderTopArtists(topArtistsData);
        renderTopTracks(topTracksData);
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
            topArtistsListContainer.innerHTML = '<h2>Meine Top Künstler</h2><p style="text-align: center;">Top-Künstler konnten nicht geladen werden.</p>';
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
            topTracksListContainer.innerHTML = '<h2>Meine Top Titel</h2><p style="text-align: center;">Top-Titel konnten nicht geladen werden.</p>';
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

    initialize();
});
