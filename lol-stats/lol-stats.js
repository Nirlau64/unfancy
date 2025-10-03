// lol-stats.js
// Fetches and displays League of Legends stats for Nirlau61#EUW from api.nirlau.de

document.addEventListener('DOMContentLoaded', async function() {
    const container = document.getElementById('lol-stats-container');1
    container.innerHTML = '<p>Lade Statistiken ...</p>';

    // -- häufige Queues als lesbarer Name --
    const QUEUE_MAP = {
      420: "Ranked Solo 5v5",
      440: "Ranked Flex 5v5",
      430: "Normal Blind",
      400: "Normal Draft",
      450: "ARAM",
      700: "Clash",
      830: "Coop vs AI (Intro)",
      840: "Coop vs AI (Beginner)",
      850: "Coop vs AI (Intermediate)"
    };
    const readableMode = (match) => {
      // bevorzugt: falls der Worker das schon liefert
      if (match.gameModeReadable) return match.gameModeReadable;
      // sonst: aus queueId mappen
      if (typeof match.queueId === "number" && QUEUE_MAP[match.queueId]) return QUEUE_MAP[match.queueId];
      // Fallback: gameMode-String (CLASSIC, ARAM, URF, …)
      if (match.gameMode) return match.gameMode;
      // letzter Fallback: Queue-ID anzeigen
      if (match.queueId != null) return `Queue ${match.queueId}`;
      return "-";
    };

    // Data Dragon Patch-Version (ggf. aktuell halten)
    async function getLatestDDragonVersion() {
        const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
        if (!res.ok) throw new Error('Fehler beim Abrufen der Version');
        const versions = await res.json();
        return versions[0]; // neueste Version
    }

    // PATCH and CHAMPION_FULL_URL will be set before use
    let PATCH = null;
    let CHAMPION_FULL_URL = null;

    async function main() {
        try {
            PATCH = await getLatestDDragonVersion();
        } catch (e) {
            PATCH = '15.9.1'; // fallback
        }
        CHAMPION_FULL_URL = `https://ddragon.leagueoflegends.com/cdn/${PATCH}/data/en_US/championFull.json`;
        console.log(CHAMPION_FULL_URL);
    }
    await main();

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
        if (typeof data.totalMasteryPoints === 'number') {
            html += `<p>Gesamt Mastery: ${data.totalMasteryPoints.toLocaleString('de-DE')}</p>`;
        }

        // Account-Erstellungsdatum (exakt oder Approximation)
        let created = data.accountCreatedAt || data.accountCreatedAtApprox;
        if (created) {
            const date = new Date(created);
            html += `<p>Account erstellt am: ${date.toLocaleDateString('de-DE')}</p>`;
        }

        if (data.masteryTop3 && data.masteryTop3.length) {
            html += '<h3>Meistgespielte Champions</h3>';
            html += '<ol style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;list-style:none;padding:0;">';
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
        if (data.recentMatches && Array.isArray(data.recentMatches) && data.recentMatches.length) {
            html += '<h3>Letzte 10 Spiele</h3>';
            html += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.98em;min-width:560px;">';
            html += '<thead><tr><th>Champion</th><th>K/D/A</th><th>CS</th><th>Dauer</th><th>Gamemode</th><th>Ergebnis</th></tr></thead><tbody>';
            data.recentMatches.slice(0, 10).forEach(match => {
                if (!match.you) return;
                let champData = champMap[String(match.you.championId)] || champMap[match.you.championId];
                const champName = champData ? champData.name : `ID ${match.you.championId}`;
                const champImg = champData ? `<img src="${champData.imageUrl}" alt="${champName}" style="width:32px;height:32px;vertical-align:middle;">` : '';
                const kda = `${match.you.kills}/${match.you.deaths}/${match.you.assists}`;
                const cs = match.you.cs !== undefined ? match.you.cs : '-';
                const duration = match.gameDuration ? `${Math.floor(match.gameDuration/60)}:${('0'+(match.gameDuration%60)).slice(-2)}` : '-';
                const mode = readableMode(match);
                const result = match.you.win ? 'Sieg' : 'Niederlage';
                html += `<tr style="text-align:center;">
                    <td>${champImg} ${champName}</td>
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
