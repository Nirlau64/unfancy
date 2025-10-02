// lol-stats.js
// Fetches and displays League of Legends stats for Nirlau61#EUW from api.nirlau.de

document.addEventListener('DOMContentLoaded', async function() {
    const container = document.getElementById('lol-stats-container');
    container.innerHTML = '<p>Lade Statistiken ...</p>';

    // Data Dragon Patch-Version (ggf. aktuell halten)
    const PATCH = '14.19.1';
    const CHAMPION_FULL_URL = `https://ddragon.leagueoflegends.com/cdn/${PATCH}/data/en_US/championFull.json`;

    // Hilfsfunktion: ChampionId → {name, imageUrl}
    async function getChampionMap() {
        const res = await fetch(CHAMPION_FULL_URL);
        const data = await res.json();
        // Mapping: id (als String) → {name, imageUrl}
        const idToData = {};
        for (const champName in data.keys) {
            const id = data.keys[champName];
            idToData[id] = {
                name: champName,
                imageUrl: `https://ddragon.leagueoflegends.com/cdn/${PATCH}/img/champion/${champName}.png`
            };
        }
        return idToData;
    }

    try {
        // Neue API-Route: /lol/Nirlau61/EUW/euw
        const response = await fetch('https://api.nirlau.de/lol/Nirlau61/EUW/euw');
        if (!response.ok) throw new Error('Fehler beim Laden der Daten');
        const data = await response.json();

        // Champion-Mapping laden
        const champMap = await getChampionMap();

        let html = '';
        html += `<h2>Summoner: Nirlau61</h2>`;
        html += `<p>Level: ${data.level || 'N/A'}</p>`;

        if (data.ranked) {
            html += '<h3>Ranked Stats</h3>';
            html += `<ul>`;
            html += `<li>Tier: ${data.ranked.tier || 'N/A'} ${data.ranked.rank || ''}</li>`;
            html += `<li>LP: ${data.ranked.lp || 'N/A'}</li>`;
            html += `<li>Wins: ${data.ranked.wins || 'N/A'}</li>`;
            html += `<li>Losses: ${data.ranked.losses || 'N/A'}</li>`;
            if (data.ranked.wins && data.ranked.losses) {
                const winrate = (data.ranked.wins / (data.ranked.wins + data.ranked.losses) * 100).toFixed(1);
                html += `<li>Winrate: ${winrate}%</li>`;
            }
            html += `</ul>`;
        } else {
            html += '<h3>Ranked Stats</h3><p>Keine Ranked-Daten gefunden.</p>';
        }

        if (data.masteryTop3 && data.masteryTop3.length) {
            html += '<h3>Meistgespielte Champions</h3>';
            html += '<ol style="display:flex;gap:20px;list-style:none;padding:0;">';
            data.masteryTop3.forEach(champ => {
                const champData = champMap[String(champ.championId)];
                if (champData) {
                    html += `<li style="text-align:center;">
                        <img src="${champData.imageUrl}" alt="${champData.name}" style="width:64px;height:64px;display:block;margin:0 auto 8px;">
                        <div>${champData.name}</div>
                        <div style="font-size:0.9em;color:#666;">${champ.points} Punkte</div>
                    </li>`;
                } else {
                    html += `<li>Champion-ID ${champ.championId} (${champ.points} Punkte)</li>`;
                }
            });
            html += '</ol>';
        }
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<p style=\"color:red;\">Fehler beim Laden der Statistiken: ${err.message}</p>`;
    }
});
