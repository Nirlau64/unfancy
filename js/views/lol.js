/**
 * View Controller: League of Legends
 */
import { fetchAPI } from '../api.js';
import { CONFIG, setupSplashHover, preloadImages, renderError } from '../utils.js';

export async function initLoL() {
    const profileContainer = document.getElementById('lol-profile');
    const statsContainer = document.getElementById('lol-stats-container');
    if (!profileContainer || !statsContainer) return;

    try {
        const [versions, queues] = await Promise.all([
            fetch('https://ddragon.leagueoflegends.com/api/versions.json').then(r => r.json()),
            fetch('https://static.developer.riotgames.com/docs/lol/queues.json').then(r => r.json())
        ]);
        
        const patch = versions[0];
        const queueMap = {};
        queues.forEach(q => queueMap[q.queueId] = q.description || `Queue ${q.queueId}`);

        const [champRes, data] = await Promise.all([
            fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`).then(r => r.json()),
            fetchAPI(CONFIG.API.LOL)
        ]);

        const champMap = {};
        for (const cName in champRes.data) {
            const c = champRes.data[cName];
            champMap[c.key] = { 
                name: c.name, 
                img: `https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/${c.id}.png`,
                id: c.id
            };
        }

        renderLoLProfile(profileContainer, data);
        renderLoLStats(statsContainer, data, champMap, queueMap);

    } catch (e) {
        console.error("LoL initialization error", e);
        renderError(statsContainer, "LoL-Daten konnten nicht geladen werden.", initLoL);
    }
}

function renderLoLProfile(container, data) {
    while (container.firstChild) container.removeChild(container.firstChild);

    const h2 = document.createElement('h2');
    h2.textContent = 'Summoner: Nirlau61';
    container.appendChild(h2);

    const pLevel = document.createElement('p');
    pLevel.textContent = `Level: ${data.level || 'N/A'}`;
    container.appendChild(pLevel);

    if (data.totalMasteryPoints) {
        const pMastery = document.createElement('p');
        pMastery.textContent = `Gesamt Mastery: ${data.totalMasteryPoints.toLocaleString('de-DE')}`;
        container.appendChild(pMastery);
    }
}

function renderLoLStats(container, data, champMap, queueMap) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add('section-relative');

    const splashBg = document.createElement('div');
    splashBg.className = 'splash-bg';
    container.appendChild(splashBg);

    const content = document.createElement('div');
    content.className = 'splash-content';

    const splashUrls = [];

    if (data.masteryTop3?.length) {
        const h3Top = document.createElement('h3');
        h3Top.className = 'text-center';
        h3Top.textContent = 'Top Champions';
        content.appendChild(h3Top);

        const list = document.createElement('ul');
        list.className = 'champ-list';

        data.masteryTop3.forEach(c => {
            const cd = champMap[c.championId];
            const splashUrl = cd ? `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${cd.id}_0.jpg` : '';
            if (splashUrl) splashUrls.push(splashUrl);

            const li = document.createElement('li');
            li.className = 'lol-match-row';
            li.dataset.splash = splashUrl;

            if (cd) {
                const img = document.createElement('img');
                img.src = cd.img;
                img.alt = cd.name;
                li.appendChild(img);

                const nameDiv = document.createElement('div');
                nameDiv.textContent = cd.name;
                li.appendChild(nameDiv);
            }

            const pointsDiv = document.createElement('div');
            pointsDiv.className = 'text-muted';
            pointsDiv.style.fontSize = '0.85em';
            pointsDiv.textContent = `${c.points.toLocaleString('de-DE')} Pkt`;
            li.appendChild(pointsDiv);

            list.appendChild(li);
        });
        content.appendChild(list);
    }

    if (data.recentMatches?.length) {
        const h3Recent = document.createElement('h3');
        h3Recent.className = 'text-center';
        h3Recent.textContent = 'Letzte 10 Spiele';
        content.appendChild(h3Recent);

        const tableWrap = document.createElement('div');
        tableWrap.className = 'lol-table-wrap';
        
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        ['Champion', 'K/D/A', 'CS', 'Dauer', 'Modus', 'Ergebnis'].forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        data.recentMatches.slice(0, 10).forEach(m => {
            if (!m.you) return;
            const cd = champMap[m.you.championId];
            const res = (m.isArena && m.you.arenaPlacement) ? `${m.you.arenaPlacement}. Platz` : (m.you.win ? 'Sieg' : 'Niederlage');
            const splashUrl = cd ? `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${cd.id}_0.jpg` : '';
            if (splashUrl) splashUrls.push(splashUrl);

            const tr = document.createElement('tr');
            tr.className = 'lol-match-row';
            tr.dataset.splash = splashUrl;

            // Champion
            const tdChamp = document.createElement('td');
            if (cd) {
                const img = document.createElement('img');
                img.src = cd.img;
                img.alt = cd.name;
                tdChamp.appendChild(img);
            }
            tdChamp.appendChild(document.createTextNode(` ${cd ? cd.name : m.you.championId}`));
            tr.appendChild(tdChamp);

            // KDA
            const tdKDA = document.createElement('td');
            tdKDA.textContent = `${m.you.kills}/${m.you.deaths}/${m.you.assists}`;
            tr.appendChild(tdKDA);

            // CS
            const tdCS = document.createElement('td');
            tdCS.textContent = m.you.cs ?? '-';
            tr.appendChild(tdCS);

            // Duration
            const tdDuration = document.createElement('td');
            tdDuration.textContent = m.gameDuration ? `${Math.floor(m.gameDuration/60)}:${('0'+(m.gameDuration%60)).slice(-2)}` : '-';
            tr.appendChild(tdDuration);

            // Mode
            const tdMode = document.createElement('td');
            tdMode.textContent = queueMap[m.queueId] || m.gameModeReadable || m.gameMode || '-';
            tr.appendChild(tdMode);

            // Result
            const tdRes = document.createElement('td');
            tdRes.textContent = res;
            tdRes.style.color = res === 'Sieg' ? '#4ade80' : (res === 'Niederlage' ? '#f43f5e' : 'inherit');
            tr.appendChild(tdRes);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        content.appendChild(tableWrap);
    }

    container.appendChild(content);
    preloadImages(splashUrls);
    setupSplashHover(container, '.lol-match-row', '.splash-bg');
}
