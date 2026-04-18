/**
 * View Controller: Steam
 */
import { fetchAPI } from '../api.js';
import { CONFIG, minutesToHours, setupSplashHover, preloadImages, renderError } from '../utils.js';

let steamChartInstance = null;

export async function initSteam() {
    const profileDiv = document.getElementById('steam-profile');
    const statsDiv = document.getElementById('steam-stats');
    if (!profileDiv || !statsDiv) return;

    try {
        const [profile, owned, achievementsRes] = await Promise.all([
            fetchAPI(`${CONFIG.API.STEAM}/profile?steamid=${CONFIG.STEAM_ID}`),
            fetchAPI(`${CONFIG.API.STEAM}/owned?steamid=${CONFIG.STEAM_ID}`),
            fetchAPI(`${CONFIG.API.STEAM}/rarest-achievements?steamid=${CONFIG.STEAM_ID}`).catch(() => ({ rarest: [] }))
        ]);

        renderSteamProfile(profileDiv, profile);
        renderSteamStats(statsDiv, owned, achievementsRes);

    } catch (e) {
        console.error("Steam initialization error", e);
        renderError(profileDiv, "Steam-Daten konnten nicht geladen werden.", initSteam);
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
    link.textContent = 'Steam-Profil öffnen';
    info.appendChild(link);
    
    header.appendChild(info);
    container.appendChild(header);
}

function renderSteamStats(container, owned, achievementsRes) {
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

    const h3MostPlayed = document.createElement('h3');
    h3MostPlayed.className = 'text-center';
    h3MostPlayed.textContent = 'Meistgespielte Spiele';
    content.appendChild(h3MostPlayed);

    const grid = document.createElement('div');
    grid.className = 'steam-grid';

    top16.forEach(g => {
        const card = document.createElement('a');
        card.href = `https://store.steampowered.com/app/${g.appid}`;
        card.target = '_blank';
        card.className = 'steam-game-card';
        card.dataset.splash = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/library_hero.jpg`;

        const img = document.createElement('img');
        img.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/capsule_231x87.jpg`;
        img.onerror = () => { img.src = `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_logo_url}.jpg`; };
        img.alt = g.name;
        card.appendChild(img);

        const title = document.createElement('div');
        title.className = 'steam-game-title';
        title.textContent = g.name;
        card.appendChild(title);

        const time = document.createElement('div');
        time.className = 'text-muted';
        time.textContent = `${minutesToHours(g.playtime_minutes)} Std.`;
        card.appendChild(time);

        grid.appendChild(card);
    });
    content.appendChild(grid);

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

    container.appendChild(content);
    setupSplashHover(container, '.steam-game-card', '.splash-bg');

    renderChart(sortedGames, totalMins);
}

function renderChart(sortedGames, totalMins) {
    const chartCanvas = document.getElementById('steam-chart');
    if (!chartCanvas) return;

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
