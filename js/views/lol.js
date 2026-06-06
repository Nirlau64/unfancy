/**
 * View Controller: League of Legends
 */
import { fetchAPI } from '../api.js';
import { CONFIG, setupSplashHover, preloadImages, renderError, getRelativeTime, renderSkeleton } from '../utils.js';

export async function initLoL(signal = null) {
    const profileContainer = document.getElementById('lol-profile');
    const statsContainer = document.getElementById('lol-stats-container');
    if (!profileContainer || !statsContainer) return;

    renderSkeleton(profileContainer, 'list', 1);
    renderSkeleton(statsContainer, 'grid', 4);

    const fetchTime = Date.now();

    try {
        const [versions, queues] = await Promise.all([
            fetch('https://ddragon.leagueoflegends.com/api/versions.json', { signal }).then(r => r.json()),
            fetch('https://static.developer.riotgames.com/docs/lol/queues.json', { signal }).then(r => r.json())
        ]);
        
        if (signal?.aborted) return;

        const patch = versions[0];
        const queueMap = {};
        queues.forEach(q => queueMap[q.queueId] = q.description || `Queue ${q.queueId}`);

        const [champRes, data] = await Promise.all([
            fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`, { signal }).then(r => r.json()),
            fetchAPI(CONFIG.API.LOL, false, signal)
        ]);

        if (signal?.aborted) return;

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
        renderLoLStats(statsContainer, data, champMap, queueMap, fetchTime);

    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error("LoL initialization error", e);
        renderError(statsContainer, "LoL-Daten konnten nicht geladen werden.", () => initLoL(signal));
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

function renderLoLStats(container, data, champMap, queueMap, fetchTime) {
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

        const matches10 = data.recentMatches.slice(0, 10);
        
        // Aggregated Stats
        const srMatches = matches10.filter(m => !m.isArena);
        let wins = 0, kills = 0, deaths = 0, assists = 0, cs = 0;
        
        matches10.forEach(m => {
            if (m.you && m.you.win) wins++;
            if (m.you) {
                kills += m.you.kills || 0;
                deaths += m.you.deaths || 0;
                assists += m.you.assists || 0;
            }
        });
        srMatches.forEach(m => { if(m.you) cs += m.you.cs || 0; });

        const winrate = matches10.length ? ((wins / matches10.length) * 100).toFixed(0) : 0;
        const avgK = matches10.length ? (kills / matches10.length).toFixed(1) : 0;
        const avgD = matches10.length ? (deaths / matches10.length).toFixed(1) : 0;
        const avgA = matches10.length ? (assists / matches10.length).toFixed(1) : 0;
        const avgCS = srMatches.length ? Math.round(cs / srMatches.length) : 0;

        const statsRow = document.createElement('div');
        statsRow.style.display = 'flex';
        statsRow.style.justifyContent = 'center';
        statsRow.style.gap = '20px';
        statsRow.style.flexWrap = 'wrap';
        statsRow.style.marginBottom = '20px';
        statsRow.innerHTML = `
            <div style="background:var(--bg-card); padding:10px 20px; border-radius:10px; border:1px solid var(--border);"><strong>Winrate:</strong> <span style="color:${winrate >= 50 ? '#4ade80' : '#f43f5e'}">${winrate}%</span></div>
            <div style="background:var(--bg-card); padding:10px 20px; border-radius:10px; border:1px solid var(--border);"><strong>Ø KDA:</strong> ${avgK} / ${avgD} / ${avgA}</div>
            ${srMatches.length ? `<div style="background:var(--bg-card); padding:10px 20px; border-radius:10px; border:1px solid var(--border);"><strong>Ø CS (SR):</strong> ${avgCS}</div>` : ''}
        `;
        content.appendChild(statsRow);

        const tableWrap = document.createElement('div');
        tableWrap.className = 'lol-table-wrap';
        
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        ['Champion', 'K/D/A', 'CS', 'Dauer', 'Modus', 'Datum', 'Ergebnis'].forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            if (text === 'Datum') th.className = 'desktop-only';
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        matches10.forEach(m => {
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
            let modeName = queueMap[m.queueId] || m.gameModeReadable || m.gameMode || '-';
            if (modeName.toUpperCase() === 'CHERRY') modeName = 'Arena';
            
            const tdMode = document.createElement('td');
            tdMode.innerHTML = `<span>${modeName}</span><br><span class="mobile-only text-muted" style="font-size:0.85em; white-space:nowrap;">${getRelativeTime(m.gameCreation)}</span>`;
            tr.appendChild(tdMode);

            // Date (Desktop only)
            const tdDate = document.createElement('td');
            tdDate.className = 'desktop-only';
            tdDate.style.whiteSpace = 'nowrap';
            tdDate.textContent = getRelativeTime(m.gameCreation);
            tr.appendChild(tdDate);

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

    if (fetchTime) {
        const timeP = document.createElement('p');
        timeP.className = 'text-center text-muted';
        timeP.style.marginTop = '20px';
        timeP.style.fontSize = '0.8em';
        timeP.textContent = `Zuletzt aktualisiert: ${getRelativeTime(fetchTime)}`;
        content.appendChild(timeP);
    }

    container.appendChild(content);
    preloadImages(splashUrls);
    setupSplashHover(container, '.lol-match-row', '.splash-bg');
}
