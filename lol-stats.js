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
        // Data.keys: {"Sona": "37", ...}
        for (const champName in data.keys) {
            const id = data.keys[champName];
            idToData[id] = {
                name: champName,
                imageUrl: `https://ddragon.leagueoflegends.com/cdn/${PATCH}/img/champion/${champName}.png`
            };
        }
        // Fallback: auch alle championId als Zahl und String mappen
        for (const champName in data.data) {
            const champ = data.data[champName];
            idToData[champ.key] = {
                name: champ.id,
                imageUrl: `https://ddragon.leagueoflegends.com/cdn/${PATCH}/img/champion/${champ.id}.png`
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

        // Gesamt-Mastery
        if (typeof data.totalMastery === 'number') {
            html += `<p>Gesamt Mastery: ${data.totalMastery.toLocaleString('de-DE')}</p>`;
        }

        // Account-Erstellungsdatum
        if (data.accountCreated) {
            const date = new Date(data.accountCreated);
            html += `<p>Account erstellt am: ${date.toLocaleDateString('de-DE')}</p>`;
        }

        if (data.masteryTop3 && data.masteryTop3.length) {
            html += '<h3>Meistgespielte Champions</h3>';
            html += '<ol style="display:flex;gap:20px;list-style:none;padding:0;">';
            data.masteryTop3.forEach(champ => {
                let champData = champMap[String(champ.championId)];
                if (!champData) champData = champMap[champ.championId];
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

        // Letzte 10 Spiele
        if (data.matches && Array.isArray(data.matches) && data.matches.length) {
            html += '<h3>Letzte 10 Spiele</h3>';
            html += '<table style="width:100%;border-collapse:collapse;font-size:0.98em;">';
            html += '<thead><tr><th>Champion</th><th>K/D/A</th><th>CS</th><th>Dauer</th><th>Ergebnis</th></tr></thead><tbody>';
            data.matches.slice(0, 10).forEach(match => {
                let champData = champMap[String(match.championId)] || champMap[match.championId];
                const champName = champData ? champData.name : `ID ${match.championId}`;
                const champImg = champData ? `<img src="${champData.imageUrl}" alt="${champName}" style="width:32px;height:32px;vertical-align:middle;">` : '';
                const kda = `${match.kills}/${match.deaths}/${match.assists}`;
                const cs = match.cs !== undefined ? match.cs : '-';
                const duration = match.duration ? `${Math.floor(match.duration/60)}:${('0'+(match.duration%60)).slice(-2)}` : '-';
                const result = match.win ? 'Sieg' : 'Niederlage';
                html += `<tr style="text-align:center;">
                    <td>${champImg} ${champName}</td>
                    <td>${kda}</td>
                    <td>${cs}</td>
                    <td>${duration}</td>
                    <td>${result}</td>
                </tr>`;
            });
            html += '</tbody></table>';
        }

        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<p style=\"color:red;\">Fehler beim Laden der Statistiken: ${err.message}</p>`;
    }
});
