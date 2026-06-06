/**
 * View Controller: Steam
 */
import { fetchAPI } from '../api.js';
import { CONFIG, minutesToHours, setupSplashHover, preloadImages, renderError, getRelativeTime, renderSkeleton } from '../utils.js';

/**
 * Dynamically loads Chart.js only when needed (~200KB).
 */
async function loadChartJS() {
    if (window.Chart) return;
    await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

let steamChartInstance = null;

/**
 * Cleans up resources like Chart.js instances.
 */
export function cleanupSteam() {
    if (steamChartInstance) {
        console.log('Cleaning up Steam Chart instance');
        steamChartInstance.destroy();
        steamChartInstance = null;
    }
}

export async function initSteam(signal = null) {
    const profileDiv = document.getElementById('steam-profile');
    const statsDiv = document.getElementById('steam-stats');
    if (!profileDiv || !statsDiv) return;

    renderSkeleton(profileDiv, 'list', 1);
    renderSkeleton(statsDiv, 'grid', 8);

    const fetchTime = Date.now();

    try {
        const [profile, owned, achievementsRes] = await Promise.all([
            fetchAPI(`${CONFIG.API.STEAM}/profile?steamid=${CONFIG.STEAM_ID}`, false, signal),
            fetchAPI(`${CONFIG.API.STEAM}/owned?steamid=${CONFIG.STEAM_ID}`, false, signal),
            fetchAPI(`${CONFIG.API.STEAM}/rarest-achievements?steamid=${CONFIG.STEAM_ID}`, false, signal).catch(() => ({ rarest: [] }))
        ]);

        if (signal?.aborted) return;

        renderSteamProfile(profileDiv, profile);
        renderSteamStats(statsDiv, owned, achievementsRes, fetchTime);

    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error("Steam initialization error", e);
        renderError(profileDiv, "Steam-Daten konnten nicht geladen werden.", () => initSteam(signal));
    }
}

function renderSteamProfile(container, profile) {
    while (container.firstChild) container.removeChild(container.firstChild);

    const header = document.createElement('div');
    header.className = 'profile-header';
    
    const img = document.createElement('img');
    img.src = profile.avatar;
    img.alt = 'Avatar';
    header.appendChild(img);
    
    const info = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = profile.persona;
    info.appendChild(strong);
    info.appendChild(document.createElement('br'));
    
    const link = document.createElement('a');
    link.href = profile.profileurl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Steam-Profil öffnen';
    info.appendChild(link);
    
    header.appendChild(info);
    container.appendChild(header);
}

function renderSteamStats(container, owned, achievementsRes, fetchTime) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add('section-relative');

    const isBlocked = (g) => CONFIG.STEAM_BLOCKLIST.has(g.appid) || /soundpad|wallpaper\s*engine|steamvr|redistributables|benchmark|sdk\b|\beditor\b|tool|server|soundtrack|demo\b|playtest|test\b/i.test(g.name || "");
    const validGames = (owned.games || []).filter(g => !isBlocked(g));
    const unplayed = validGames.filter(g => g.playtime_minutes === 0).length;
    const totalMins = validGames.reduce((s, g) => s + (g.playtime_minutes || 0), 0);
    const sortedGames = [...validGames].sort((a,b) => b.playtime_minutes - a.playtime_minutes);
    const top16 = sortedGames.slice(0, 16);

    // Preload splash images
    preloadImages(top16.map(g => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/library_hero.jpg`));

    const splashBg = document.createElement('div');
    splashBg.className = 'splash-bg';
    container.appendChild(splashBg);

    const content = document.createElement('div');
    content.className = 'splash-content';

    const h2 = document.createElement('h2');
    h2.className = 'text-center';
    h2.textContent = `Gesamtspielzeit: ${minutesToHours(totalMins)} Stunden`;
    content.appendChild(h2);

    const pBacklog = document.createElement('p');
    pBacklog.className = 'text-center text-muted';
    pBacklog.style.marginTop = '-10px';
    pBacklog.textContent = `${unplayed} ungespielte Spiele im Backlog`;
    content.appendChild(pBacklog);

    // Sorting controls
    let sortBy = 'playtime';
    let sortDesc = true;

    const sortControls = document.createElement('div');
    sortControls.className = 'time-range-buttons'; // reuse existing style
    sortControls.style.marginBottom = '20px';

    const btnSortTime = document.createElement('button');
    btnSortTime.textContent = 'Nach Spielzeit (absteigend)';
    btnSortTime.className = 'active';

    const btnSortName = document.createElement('button');
    btnSortName.textContent = 'Nach Name';

    sortControls.appendChild(btnSortTime);
    sortControls.appendChild(btnSortName);
    content.appendChild(sortControls);

    const h3MostPlayed = document.createElement('h3');
    h3MostPlayed.className = 'text-center';
    h3MostPlayed.textContent = 'Meistgespielte Spiele';
    content.appendChild(h3MostPlayed);

    const grid = document.createElement('div');
    grid.className = 'steam-grid';
    content.appendChild(grid);

    function updateGrid() {
        grid.innerHTML = '';
        
        const currentSorted = [...validGames].sort((a,b) => {
            if (sortBy === 'name') {
                return sortDesc ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name);
            } else {
                return sortDesc ? b.playtime_minutes - a.playtime_minutes : a.playtime_minutes - b.playtime_minutes;
            }
        });
        const currentTop16 = currentSorted.slice(0, 16);

        currentTop16.forEach(g => {
            const card = document.createElement('a');
            card.href = `https://store.steampowered.com/app/${g.appid}`;
            card.target = '_blank';
            card.rel = 'noopener noreferrer';
            card.className = 'steam-game-card';
            card.dataset.splash = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/library_hero.jpg`;

            const img = document.createElement('img');
            img.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/capsule_231x87.jpg`;
            img.onerror = () => { img.src = `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${encodeURIComponent(g.img_logo_url || '')}.jpg`; };
            img.alt = g.name;
            card.appendChild(img);

            const title = document.createElement('div');
            title.className = 'steam-game-title';
            title.textContent = g.name;
            card.appendChild(title);

            const time = document.createElement('div');
            time.className = 'text-muted';
            const percentage = ((g.playtime_minutes / totalMins) * 100).toFixed(1);
            time.textContent = `${minutesToHours(g.playtime_minutes)} Std. (${percentage}%)`;
            card.appendChild(time);

            grid.appendChild(card);
        });
        
        // Re-attach hover listeners for the new DOM nodes
        setupSplashHover(container, '.steam-game-card', '.splash-bg');
    }

    btnSortTime.addEventListener('click', () => {
        if (sortBy === 'playtime') sortDesc = !sortDesc;
        else { sortBy = 'playtime'; sortDesc = true; }
        
        btnSortTime.className = 'active';
        btnSortName.className = '';
        btnSortTime.textContent = `Nach Spielzeit (${sortDesc ? 'absteigend' : 'aufsteigend'})`;
        btnSortName.textContent = 'Nach Name';
        updateGrid();
    });

    btnSortName.addEventListener('click', () => {
        if (sortBy === 'name') sortDesc = !sortDesc;
        else { sortBy = 'name'; sortDesc = false; }
        
        btnSortName.className = 'active';
        btnSortTime.className = '';
        btnSortName.textContent = `Nach Name (${sortDesc ? 'Z-A' : 'A-Z'})`;
        btnSortTime.textContent = 'Nach Spielzeit';
        updateGrid();
    });

    updateGrid();

    // (removed old loop because it's now in updateGrid)

    if (achievementsRes?.rarest?.length) {
        content.appendChild(document.createElement('hr'));
        const h3Achievements = document.createElement('h3');
        h3Achievements.className = 'text-center';
        h3Achievements.textContent = 'Seltenste Errungenschaften';
        content.appendChild(h3Achievements);

        const achGrid = document.createElement('div');
        achGrid.className = 'achievement-grid';

        achievementsRes.rarest.forEach(a => {
            const achCard = document.createElement('div');
            achCard.className = 'achievement-card';

            const img = document.createElement('img');
            img.src = a.icon;
            img.alt = a.name;
            achCard.appendChild(img);

            const achInfo = document.createElement('div');
            achInfo.className = 'achievement-info';
            
            const achName = document.createElement('span');
            achName.className = 'achievement-name';
            achName.textContent = a.name;
            achInfo.appendChild(achName);

            const achGame = document.createElement('span');
            achGame.className = 'achievement-game';
            achGame.textContent = a.gameName;
            achInfo.appendChild(achGame);

            achCard.appendChild(achInfo);

            const rarity = document.createElement('span');
            rarity.className = 'achievement-rarity';
            rarity.textContent = `${a.percent}%`;
            achCard.appendChild(rarity);

            achGrid.appendChild(achCard);
        });
        content.appendChild(achGrid);
    }

    if (fetchTime) {
        const timeP = document.createElement('p');
        timeP.className = 'text-center text-muted';
        timeP.style.marginTop = '20px';
        timeP.style.fontSize = '0.8em';
        timeP.textContent = `Zuletzt aktualisiert: ${getRelativeTime(fetchTime)}`;
        content.appendChild(timeP);
    }

    container.appendChild(content);
    setupSplashHover(container, '.steam-game-card', '.splash-bg');

    renderChart(sortedGames, totalMins);
}

async function renderChart(sortedGames, totalMins) {
    const chartCanvas = document.getElementById('steam-chart');
    if (!chartCanvas) return;

    try {
        await loadChartJS();
    } catch (e) {
        console.error('Chart.js konnte nicht geladen werden:', e);
        return;
    }

    if (steamChartInstance) steamChartInstance.destroy();

    const top10 = sortedGames.slice(0, 10);
    const top10Mins = top10.reduce((s, g) => s + g.playtime_minutes, 0);

    const ctx = chartCanvas.getContext('2d');
    steamChartInstance = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: [...top10.map(g => g.name), 'Andere'],
            datasets: [{
                data: [...top10.map(g => g.playtime_minutes), (totalMins - top10Mins)],
                backgroundColor: ['#7dd3fc','#3b82f6','#8b5cf6','#d946ef','#f43f5e','#f97316','#facc15','#4ade80','#2dd4bf','#a3e635','#6b7280'],
                borderColor: '#181a20',
                borderWidth: 2
            }]
        },
        options: {
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: 'white' }
                }
            }
        }
    });
}
