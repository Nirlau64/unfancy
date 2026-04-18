/**
 * Unfancy Dashboard - Core Logic & Router
 */

// --- 1. CONFIGURATION ---
const CONFIG = {
    STEAM_ID: "76561198159661156",
    API: {
        SPOTIFY: "https://spotify.api.nirlau.de",
        STEAM: "https://steam.api.nirlau.de",
        LOL: "https://api.nirlau.de/lol/Nirlau61/EUW/euw",
        YT_RSS: "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.youtube.com%2Ffeeds%2Fvideos.xml%3Fchannel_id%3DUCmr2wtpiZuDvwpShCNF9tng"
    },
    STEAM_BLOCKLIST: new Set([629520, 744190, 431960, 250820, 228980, 480]),
    DEFAULT_ACCENT: '#3b82f6'
};

let steamChartInstance = null;
const loadedPages = new Set();

// --- 2. CORE HELPERS ---
async function getDominantColor(imgUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = imgUrl;
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = 1; canvas.height = 1;
                ctx.drawImage(img, 0, 0, 1, 1);
                const data = ctx.getImageData(0, 0, 1, 1).data;
                const color = `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
                console.log("New accent color extracted:", color);
                resolve(color);
            } catch (e) {
                console.warn("Canvas access blocked (CORS). Using default.");
                resolve(CONFIG.DEFAULT_ACCENT);
            }
        };
        img.onerror = () => resolve(CONFIG.DEFAULT_ACCENT);
        // Timeout after 2s
        setTimeout(() => resolve(CONFIG.DEFAULT_ACCENT), 2000);
    });
}

function updateAccentColor(color) {
    if (!color) return;
    document.documentElement.style.setProperty('--accent', color);
    
    // Create a semi-transparent version for shadows or overlays
    const rgba = color.replace('rgb', 'rgba').replace(')', ', 0.3)');
    document.documentElement.style.setProperty('--accent-muted', rgba);
    
    // Also update mobile browser bar color
    let themeMeta = document.querySelector('meta[name="theme-color"]');
    if (!themeMeta) {
        themeMeta = document.createElement('meta');
        themeMeta.name = "theme-color";
        document.head.appendChild(themeMeta);
    }
    themeMeta.content = color;
}

async function fetchAPI(url, useCacheBusting = true) {
    try {
        let finalUrl = url;
        if (useCacheBusting) {
            const sep = url.includes('?') ? '&' : '?';
            finalUrl = `${url}${sep}t=${Date.now()}`;
        }
        const res = await fetch(finalUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error("Fetch Error:", err);
        throw err;
    }
}

function escapeHTML(str) {
    if(typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag]));
}

function minutesToHours(min) { return (min / 60).toFixed(1); }

// --- 3. ROUTER & TRANSITIONS ---
// Helper for Splash Effects
function setupSplashHover(container, itemSelector, bgSelector) {
    const splashBg = container.querySelector(bgSelector);
    const items = container.querySelectorAll(itemSelector);
    if (!splashBg || !items.length) return;

    items.forEach(item => {
        item.addEventListener('mouseenter', () => {
            const url = item.dataset.splash || item.querySelector('img')?.src;
            if (url) {
                splashBg.style.backgroundImage = `url('${url}')`;
                splashBg.style.opacity = '1';
            }
        });
        item.addEventListener('mouseleave', () => {
            splashBg.style.opacity = '0';
        });
    });
}

async function loadPage(url, pushState = true) {
    const contentDiv = document.getElementById('app-content');
    if (!contentDiv) return;

    contentDiv.classList.add('fade-out');

    try {
        const response = await fetch(url);
        const htmlText = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');
        const newMain = doc.getElementById('app-content');

        if (!newMain) throw new Error("Invalid page structure");

        // Wait for fade-out animation
        await new Promise(resolve => setTimeout(resolve, 300));

        contentDiv.innerHTML = newMain.innerHTML;
        if (pushState) window.history.pushState({ path: url }, '', url);

        // Update Navigation Active State
        const pageName = newMain.firstElementChild.id;
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.page === pageName);
        });

        contentDiv.classList.remove('fade-out');

        // Initialize Page Logic
        triggerPageLogic(pageName);
    } catch (error) {
        console.error("Routing Error:", error);
        window.location.href = url; // Fallback to hard reload
    }
}

function triggerPageLogic(pageName) {
    console.log(`Initializing ${pageName}...`);
    if (pageName === 'home') updateHomeStatus();
    if (pageName === 'steam') initSteam();
    if (pageName === 'spotify') initSpotify();
    if (pageName === 'lol') initLoL();
    if (pageName === 'socials') initSocials();
    loadedPages.add(pageName);
}

// --- 4. FEATURE LOGIC ---

// HOME
async function updateHomeStatus() {
    const liveSection = document.getElementById('live-status-section');
    const spEl = document.getElementById('home-spotify-status');
    const stEl = document.getElementById('home-steam-status');
    if (!liveSection || !spEl || !stEl) return;

    let hasActivity = false;
    spEl.innerHTML = ''; stEl.innerHTML = '';

    try {
        const spData = await fetchAPI(`${CONFIG.API.SPOTIFY}/now-playing`);
        if (spData && spData.is_playing) {
            const track = spData.item;
            const coverUrl = track.album.images[0].url;
            const color = await getDominantColor(coverUrl);
            updateAccentColor(color);

            const trackUrl = track.external_urls?.spotify || '#';
            spEl.innerHTML = `
                <div class="live-status-item">
                    <p>🎧 Laurin hört gerade:</p>
                    <div class="track-box">
                        <a href="${escapeHTML(trackUrl)}" target="_blank" style="display: flex;">
                            <img src="${escapeHTML(track.album.images[0].url)}" alt="Cover">
                        </a>
                        <div class="track-info">
                            <a href="${escapeHTML(trackUrl)}" target="_blank">
                                <strong>${escapeHTML(track.name)}</strong>
                            </a>
                            <span>${escapeHTML(track.artists.map(a => a.name).join(', '))}</span>
                        </div>
                    </div>
                </div>`;
            hasActivity = true;
        }
    } catch(e) {}

    try {
        const stData = await fetchAPI(`${CONFIG.API.STEAM}/currently-playing?steamid=${CONFIG.STEAM_ID}`);
        if (stData && stData.game) {
            const storeLink = stData.appid ? `https://store.steampowered.com/app/${stData.appid}` : `https://store.steampowered.com/search/?term=${encodeURIComponent(stData.game)}`;
            stEl.innerHTML = `
                <div class="live-status-item">
                    <p>🎮 Laurin spielt gerade:</p>
                    <a href="${storeLink}" target="_blank" class="live-steam-link">${escapeHTML(stData.game)}</a>
                </div>`;
            hasActivity = true;
        }
    } catch(e) {}

    liveSection.style.display = hasActivity ? 'block' : 'none';
}

// STEAM
async function initSteam() {
    const profileDiv = document.getElementById('steam-profile');
    const statsDiv = document.getElementById('steam-stats');
    if (!profileDiv || !statsDiv) return;

    try {
        const [profile, owned] = await Promise.all([
            fetchAPI(`${CONFIG.API.STEAM}/profile?steamid=${CONFIG.STEAM_ID}`),
            fetchAPI(`${CONFIG.API.STEAM}/owned?steamid=${CONFIG.STEAM_ID}`)
        ]);

        profileDiv.innerHTML = `
            <div class="profile-header">
                <img src="${escapeHTML(profile.avatar)}" alt="Avatar">
                <div>
                    <strong>${escapeHTML(profile.persona)}</strong><br>
                    <a href="${escapeHTML(profile.profileurl)}" target="_blank">Steam-Profil öffnen</a>
                </div>
            </div>`;

        const isBlocked = (g) => CONFIG.STEAM_BLOCKLIST.has(g.appid) || /soundpad|wallpaper\s*engine|steamvr|redistributables|benchmark|sdk\b|\beditor\b|tool|server|soundtrack|demo\b|playtest|test\b/i.test(g.name || "");
        const validGames = (owned.games || []).filter(g => !isBlocked(g));
        const totalMins = validGames.reduce((s, g) => s + (g.playtime_minutes || 0), 0);
        const sorted = validGames.sort((a,b) => b.playtime_minutes - a.playtime_minutes);
        const top16 = sorted.slice(0, 16);
        
        statsDiv.classList.add('section-relative');
        statsDiv.innerHTML = `
            <div class="splash-bg"></div>
            <div class="splash-content">
                <h2 class="text-center">Gesamtspielzeit: ${minutesToHours(totalMins)} Stunden</h2>
                <h3 class="text-center">Meistgespielte Spiele</h3>
                <div class="steam-grid">
                    ${top16.map(g => `
                        <a href="https://store.steampowered.com/app/${g.appid}" target="_blank" class="steam-game-card" 
                           data-splash="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/library_hero.jpg">
                            <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/capsule_231x87.jpg" 
                                 onerror="this.src='https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_logo_url}.jpg'" 
                                 alt="${escapeHTML(g.name)}">
                            <div class="steam-game-title">${escapeHTML(g.name)}</div>
                            <div class="text-muted">${minutesToHours(g.playtime_minutes)} Std.</div>
                        </a>
                    `).join('')}
                </div>
            </div>`;

        setupSplashHover(statsDiv, '.steam-game-card', '.splash-bg');

        if (steamChartInstance) steamChartInstance.destroy();
        const top10 = sorted.slice(0, 10);
        const top10Mins = top10.reduce((s, g) => s + g.playtime_minutes, 0);
        const ctx = document.getElementById('steam-chart').getContext('2d');
        steamChartInstance = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: [...top10.map(g => g.name), 'Andere'],
                datasets: [{
                    data: [...top10.map(g => g.playtime_minutes), (totalMins - top10Mins)],
                    backgroundColor: ['#7dd3fc','#3b82f6','#8b5cf6','#d946ef','#f43f5e','#f97316','#facc15','#4ade80','#2dd4bf','#a3e635','#6b7280'],
                    borderColor: '#181a20', borderWidth: 2
                }]
            },
            options: { plugins: { legend: { position: 'bottom', labels: { color: 'white' } } } }
        });
    } catch (e) {
        profileDiv.innerHTML = `<div class="error-msg">Fehler beim Laden der Steam-Daten.</div>`;
    }
}

// SPOTIFY
async function initSpotify() {
    const btns = document.querySelectorAll('.time-range-buttons button');
    if (!btns.length) return;
    btns.forEach(b => b.addEventListener('click', (e) => {
        btns.forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
        loadSpotifyData(e.target.dataset.range);
    }));
    loadSpotifyData('medium_term');
}

async function loadSpotifyData(range) {
    const artistsDiv = document.getElementById('spotify-artists');
    const tracksDiv = document.getElementById('spotify-tracks');
    const nowPlayingDiv = document.getElementById('spotify-now-playing');
    if (!artistsDiv || !tracksDiv) return;

    artistsDiv.innerHTML = `<h2>Meine Top Künstler</h2><div class="text-center text-muted">Lade...</div>`;
    tracksDiv.innerHTML = `<h2>Meine Top Titel</h2><div class="text-center text-muted">Lade...</div>`;

    try {
        const [artists, tracks, nowPlaying] = await Promise.all([
            fetchAPI(`${CONFIG.API.SPOTIFY}/top-artists?range=${range}`),
            fetchAPI(`${CONFIG.API.SPOTIFY}/top-tracks?range=${range}`),
            fetchAPI(`${CONFIG.API.SPOTIFY}/now-playing`).catch(() => null)
        ]);

        // Hide redundant now playing section in Spotify tab if it's already handled by the accent color/background
        if (nowPlayingDiv) {
            nowPlayingDiv.style.display = 'none';
        }

        // Update accent if something is playing
        if (nowPlaying && nowPlaying.is_playing) {
            const color = await getDominantColor(nowPlaying.item.album.images[0].url);
            updateAccentColor(color);
        }

        // Artists
        artistsDiv.classList.add('section-relative');
        let aHtml = `<div class="splash-bg"></div><div class="splash-content"><h2>Meine Top Künstler</h2><div class="media-grid">`;
        (artists?.items || []).forEach(a => {
            const img = a.images[0]?.url || '';
            aHtml += `<a href="${a.external_urls.spotify}" target="_blank" class="media-card artist" data-splash="${img}">
                <img src="${escapeHTML(img)}" alt="${escapeHTML(a.name)}">
                <span>${escapeHTML(a.name)}</span>
            </a>`;
        });
        artistsDiv.innerHTML = aHtml + `</div></div>`;
        setupSplashHover(artistsDiv, '.media-card', '.splash-bg');

        // Tracks
        tracksDiv.classList.add('section-relative');
        let tHtml = `<div class="splash-bg"></div><div class="splash-content"><h2>Meine Top Titel</h2><div class="media-grid">`;
        (tracks?.items || []).forEach(t => {
            const img = t.album.images[0]?.url || '';
            tHtml += `<a href="${t.external_urls.spotify}" target="_blank" class="media-card track" data-splash="${img}">
                <img src="${escapeHTML(img)}" alt="${escapeHTML(t.name)}">
                <span>${escapeHTML(t.name)}</span>
                <span class="artist-name">${escapeHTML(t.artists.map(ar => ar.name).join(', '))}</span>
            </a>`;
        });
        tracksDiv.innerHTML = tHtml + `</div></div>`;
        setupSplashHover(tracksDiv, '.media-card', '.splash-bg');
    } catch(e) {
        console.error("Spotify Data Error:", e);
        artistsDiv.innerHTML = `<div class="error-msg">Fehler beim Laden.</div>`;
    }
}

// LOL
async function initLoL() {
    const profileContainer = document.getElementById('lol-profile');
    const statsContainer = document.getElementById('lol-stats-container');
    if (!profileContainer || !statsContainer) return;

    try {
        const [versions, queues] = await Promise.all([
            fetch('https://ddragon.leagueoflegends.com/api/versions.json').then(r=>r.json()),
            fetch('https://static.developer.riotgames.com/docs/lol/queues.json').then(r=>r.json())
        ]);
        const patch = versions[0];
        const queueMap = {};
        queues.forEach(q => queueMap[q.queueId] = q.description || `Queue ${q.queueId}`);

        const [champRes, data] = await Promise.all([
            fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/championFull.json`).then(r=>r.json()),
            fetchAPI(CONFIG.API.LOL)
        ]);

        const champMap = {};
        for (const cName in champRes.data) {
            const c = champRes.data[cName];
            champMap[c.key] = { name: c.name, img: `https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/${c.id}.png` };
        }

        profileContainer.innerHTML = `<h2>Summoner: Nirlau61</h2><p>Level: ${data.level || 'N/A'}</p>` + (data.totalMasteryPoints ? `<p>Gesamt Mastery: ${data.totalMasteryPoints.toLocaleString('de-DE')}</p>` : '');

        // Wrap everything in a single section-relative container for the full background effect
        let fullHTML = `<div class="section-relative"><div class="splash-bg"></div><div class="splash-content">`;

        if (data.masteryTop3?.length) {
            fullHTML += '<h3 class="text-center">Top Champions</h3><ul class="champ-list">';
            data.masteryTop3.forEach(c => {
                const cd = champMap[c.championId];
                const splashUrl = cd ? `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${cd.img.split('/').pop().replace('.png', '')}_0.jpg` : '';
                if (cd) fullHTML += `<li class="lol-match-row" data-splash="${splashUrl}"><img src="${cd.img}" alt="${cd.name}"><div>${cd.name}</div><div class="text-muted" style="font-size:0.85em;">${c.points} Pkt</div></li>`;
            });
            fullHTML += '</ul>';
        }

        if (data.recentMatches?.length) {
            fullHTML += '<h3 class="text-center">Letzte 10 Spiele</h3><div class="lol-table-wrap"><table>';
            fullHTML += '<thead><tr><th>Champion</th><th>K/D/A</th><th>CS</th><th>Dauer</th><th>Modus</th><th>Ergebnis</th></tr></thead><tbody>';
            data.recentMatches.slice(0, 10).forEach(m => {
                if (!m.you) return;
                const cd = champMap[m.you.championId];
                const res = (m.isArena && m.you.arenaPlacement) ? `${m.you.arenaPlacement}. Platz` : (m.you.win ? 'Sieg' : 'Niederlage');
                const splashUrl = cd ? `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${cd.img.split('/').pop().replace('.png', '')}_0.jpg` : '';
                
                fullHTML += `<tr class="lol-match-row" data-splash="${splashUrl}">
                    <td>${cd ? `<img src="${cd.img}" alt="${cd.name}">` : ''} ${escapeHTML(cd ? cd.name : m.you.championId)}</td>
                    <td>${m.you.kills}/${m.you.deaths}/${m.you.assists}</td>
                    <td>${m.you.cs ?? '-'}</td>
                    <td>${m.gameDuration ? `${Math.floor(m.gameDuration/60)}:${('0'+(m.gameDuration%60)).slice(-2)}` : '-'}</td>
                    <td>${escapeHTML(queueMap[m.queueId] || m.gameModeReadable || m.gameMode || '-')}</td>
                    <td style="color: ${res==='Sieg'?'#4ade80':(res==='Niederlage'?'#f43f5e':'inherit')}">${res}</td>
                </tr>`;
            });
            fullHTML += '</tbody></table></div>';
        }
        fullHTML += '</div></div>';
        statsContainer.innerHTML = fullHTML;

        // Use the unified splash helper on the entire container
        setupSplashHover(statsContainer, '.lol-match-row', '.splash-bg');
    } catch(e) { 
        console.error(e);
        statsContainer.innerHTML = '<div class="error-msg">Fehler beim Laden der LoL-Stats.</div>'; 
    }
}

// SOCIALS
async function initSocials() {
    const ytContainer = document.getElementById('socials-yt');
    if (!ytContainer) return;
    try {
        const ytData = await fetchAPI(CONFIG.API.YT_RSS, false);
        if (ytData.status === 'ok' && ytData.items.length > 0) {
            const vidId = ytData.items[0].guid.split(':').pop();
            const origin = window.location.origin;
            ytContainer.innerHTML = `
                        <div class="yt-wrap">
                            <iframe 
                                src="https://www.youtube-nocookie.com/embed/${escapeHTML(vidId)}?rel=0&modestbranding=1&origin=${encodeURIComponent(origin)}" 
                                title="YouTube video player" 
                                frameborder="0" 
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
                                allowfullscreen>
                            </iframe>
                        </div>`;
        }
    } catch(e) { ytContainer.textContent = 'Fehler beim Laden von YouTube.'; }

    if (window.instgrm) window.instgrm.Embeds.process();
    else {
        const s = document.createElement('script');
        s.src = "https://www.instagram.com/embed.js";
        s.async = true;
        document.body.appendChild(s);
    }
}

// --- 5. INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    // Intercept Link Clicks
    document.addEventListener('click', (e) => {
        const link = e.target.closest('.nav-link');
        if (link) {
            e.preventDefault();
            loadPage(link.getAttribute('href'));
        }
    });

    // Browser Back/Forward
    window.addEventListener('popstate', () => {
        loadPage(window.location.pathname, false);
    });

    // Initial Page Logic
    const initialPage = document.getElementById('app-content').firstElementChild.id;
    triggerPageLogic(initialPage);

    // Live Status Polling (Home)
    setInterval(() => {
        if (document.getElementById('home')) updateHomeStatus();
    }, 30000);
});
