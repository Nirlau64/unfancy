/**
 * View Controller: Home
 */
import { fetchAPI } from '../api.js';
import { CONFIG, getDominantColor, updateAccentColor, escapeHTML } from '../utils.js';

export async function initHome(signal = null) {
    await updateHomeStatus(signal);
}

export async function updateHomeStatus(signal = null) {
    const liveSection = document.getElementById('live-status-section');
    const spEl = document.getElementById('home-spotify-status');
    const stEl = document.getElementById('home-steam-status');
    if (!liveSection || !spEl || !stEl) return;

    let hasActivity = false;
    
    // Spotify Status
    try {
        const spData = await fetchAPI(`${CONFIG.API.SPOTIFY}/now-playing`, true, signal);
        
        if (signal?.aborted) return;
        
        // Clear containers only if we have data to show or no activity
        // (Better to clear right before render to avoid flicker)

        if (spData?.is_playing) {
            const track = spData.item;
            const color = await getDominantColor(track.album.images[0].url);
            
            if (signal?.aborted) return;
            
            updateAccentColor(color);

            while (spEl.firstChild) spEl.removeChild(spEl.firstChild);

            const itemDiv = document.createElement('div');
            itemDiv.className = 'live-status-item';
            
            const p = document.createElement('p');
            p.textContent = '🎧 Laurin hört gerade:';
            itemDiv.appendChild(p);

            const trackBox = document.createElement('div');
            trackBox.className = 'track-box';
            
            const link = document.createElement('a');
            link.href = track.external_urls?.spotify || '#';
            link.target = '_blank';
            link.style.display = 'flex';

            const img = document.createElement('img');
            img.src = track.album.images[0].url;
            img.alt = 'Cover';
            link.appendChild(img);

            const info = document.createElement('div');
            info.className = 'track-info';
            
            const strong = document.createElement('strong');
            strong.textContent = track.name;
            info.appendChild(strong);

            const span = document.createElement('span');
            span.textContent = track.artists.map(a => a.name).join(', ');
            info.appendChild(span);

            trackBox.appendChild(link);
            trackBox.appendChild(info);
            itemDiv.appendChild(trackBox);
            spEl.appendChild(itemDiv);
            
            hasActivity = true;
        } else {
            while (spEl.firstChild) spEl.removeChild(spEl.firstChild);
        }
    } catch (e) {
        if (e.name !== 'AbortError') console.warn("Spotify Live Status error", e);
    }

    // Steam Status
    try {
        const stData = await fetchAPI(`${CONFIG.API.STEAM}/currently-playing?steamid=${CONFIG.STEAM_ID}`, true, signal);
        
        if (signal?.aborted) return;

        while (stEl.firstChild) stEl.removeChild(stEl.firstChild);

        if (stData?.game) {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'live-status-item';
            
            const p = document.createElement('p');
            p.textContent = '🎮 Laurin spielt gerade:';
            itemDiv.appendChild(p);

            const link = document.createElement('a');
            link.href = `https://store.steampowered.com/app/${stData.appid || ''}`;
            link.target = '_blank';
            link.className = 'live-steam-link';
            link.textContent = stData.game;
            
            itemDiv.appendChild(link);
            stEl.appendChild(itemDiv);
            
            hasActivity = true;
        }
    } catch (e) {
        if (e.name !== 'AbortError') console.warn("Steam Live Status error", e);
    }

    liveSection.style.display = hasActivity ? 'block' : 'none';
}
