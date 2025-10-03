// lol-stats.js
// Fetches and displays League of Legends stats for Nirlau61#EUW from api.nirlau.de
document.addEventListener('DOMContentLoaded', async function() {
    const container = document.getElementById('lol-stats-container');
    container.innerHTML = '<p>Lade Statistiken ...</p>';

    // Data Dragon Patch-Version (ggf. aktuell halten)
    async function getLatestDDragonVersion() {
        const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
        if (!res.ok) throw new Error('Fehler beim Abrufen der Version');
        const versions = await res.json();
        return versions[0]; // neueste Version
    }

    // Data Dragon Queue-Info laden
    async function getQueueMap() {
        const res = await fetch('https://static.developer.riotgames.com/docs/lol/queues.json');
        if (!res.ok) throw new Error('Fehler beim Abrufen der Queue-Daten');
        const queues = await res.json();
        const map = {};
        for (const q of queues) {
            map[q.queueId] = q.description || q.map || `Queue ${q.queueId}`;
        }
        return map;
    }

    // Hilfsfunktion: ChampionId → {name, imageUrl}
    async function getChampionMap() {
        const res = await fetch(CHAMPION_FULL_URL);
        const data = await res.json();
        const idToData = {};
        for (const champName in data.keys) {
            const id = data.keys[champName];
            idToData[id] = {
                name: champName,
                imageUrl: `https://ddragon.leagueoflegends.com/cdn/${PATCH}/img/champion/${champName}.png`
            };
        }
        for (const champName in data.data) {
            const champ = data.data[champName];
            idToData[champ.key] = {
                name: champ.id,
                imageUrl: `https://ddragon.leagueoflegends.com/cdn/${PATCH}/img/champion/${champ.id}.png`
            };
        }
        return idToData;
    }

    // Variablen vor Nutzung
    let PATCH = null;
    let CHAMPION_FULL_URL = null;
    let champMap = {};
    let QUEUE_MAP = {};

    async function main() {
        try {
            PATCH = await getLatestDDragonVersion();
        } catch (e) {
            PATCH = '15.9.1'; // fallback
        }
        CHAMPION_FULL_URL = `https://ddragon.leagueoflegends.com/cdn/${PATCH}/data/en_US/championFull.json`;
        champMap = await getChampionMap();
        QUEUE_MAP = await getQueueMap();
    }
    await main();

    try {
        const response = await fetch('https://api.nirlau.de/lol/Nirlau61/EUW/euw');
        if (!response.ok) throw new Error('Fehler beim Laden der Daten');
        const data = await response.json();

        let html = '';
        html += `<h2>Summoner: Nirlau61</h2>`;
        html += `<p>Level: ${data.level || 'N/A'}</p>`;

        if (typeof data.totalMasteryPoints === 'number') {
            html += `<p>Gesamt Mastery: ${data.totalMasteryPoints.toLocaleString('de-DE')}</p>`;
        }

        let created = data.accountCreatedAt || data.accountCreatedAtApprox;
        if (created) {
            const date = new Date(created);
            html += `<p>Account erstellt am: ${date.toLocaleDateString('de-DE')}</p>`;
        }

        if (data.masteryTop3 && data.masteryTop3.length) {
            html += '<h3>Meistgespielte Champions</h3>';
            html += '<ol style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;list-style:none;padding:0;">';
            data.masteryTop3.forEach(champ => {
                let cd = champMap[String(champ.championId)] || champMap[champ.championId];
                if (cd) {
                    html += `<li style="text-align:center;">
                        <img src="${cd.imageUrl}" alt="${cd.name}" style="width:64px;height:64px;display:block;margin:0 auto 8px;">
                        <div>${cd.name}</div>
                        <div style="font-size:0.9em;color:#666;">${champ.points} Punkte</div>
                    </li>`;
                } else {
                    html += `<li>Champion-ID ${champ.championId} (${champ.points} Punkte)</li>`;
                }
            });
            html += '</ol>';
        }

        // Letzte 10 Spiele
        if (data.recentMatches && Array.isArray(data.recentMatches) && data.recentMatches.length) {
            html += '<h3>Letzte 10 Spiele</h3>';
            html += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.98em;min-width:560px;">';
            html += '<thead><tr><th>Champion</th><th>K/D/A</th><th>CS</th><th>Dauer</th><th>Gamemode</th><th>Ergebnis</th></tr></thead><tbody>';
            data.recentMatches.slice(0, 10).forEach(match => {
                if (!match.you) return;
                const cd   = champMap[String(match.you.championId)] || champMap[match.you.championId];
                const cName = cd ? cd.name : `ID ${match.you.championId}`;
                const cImg  = cd ? `<img src="${cd.imageUrl}" alt="${cName}" style="width:32px;height:32px;vertical-align:middle;">` : '';

                const kda      = `${match.you.kills}/${match.you.deaths}/${match.you.assists}`;
                const cs       = match.you.cs !== undefined ? match.you.cs : '-';
                const duration = match.gameDuration ? `${Math.floor(match.gameDuration/60)}:${('0'+(match.gameDuration%60)).slice(-2)}` : '-';

                // Gamemode lesbar machen
                const mode = (typeof match.queueId === 'number' && QUEUE_MAP[match.queueId])
                    || match.gameModeReadable
                    || match.gameMode
                    || `Queue ${match.queueId ?? '-'}`;

                const result = match.you.win ? 'Sieg' : 'Niederlage';

                html += `<tr style="text-align:center;">
                    <td>${cImg} ${cName}</td>
                    <td>${kda}</td>
                    <td>${cs}</td>
                    <td>${duration}</td>
                    <td>${mode}</td>
                    <td>${result}</td>
                </tr>`;
            });
            html += '</tbody></table>';
        }

        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<p style="color:red;">Fehler beim Laden der Statistiken: ${err.message}</p>`;
    }
});
