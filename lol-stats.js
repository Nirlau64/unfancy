// lol-stats.js
// Fetches and displays League of Legends stats for Nirlau61#EUW from api.nirlau.de

document.addEventListener('DOMContentLoaded', async function() {
    const container = document.getElementById('lol-stats-container');
    container.innerHTML = '<p>Lade Statistiken ...</p>';

    // Mapping Champion-IDs zu Namen (minimal, für Demo; für alle Champs Data Dragon nutzen)
    const champMap = {
        37: 'Sona',
        101: 'Xerath',
        80: 'Pantheon'
        // ...weitere nach Bedarf
    };

    try {
        // Neue API-Route: /lol/Nirlau61/EUW/euw
        const response = await fetch('https://api.nirlau.de/lol/Nirlau61/EUW/euw');
        if (!response.ok) throw new Error('Fehler beim Laden der Daten');
        const data = await response.json();

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
            html += '<ol>';
            data.masteryTop3.forEach(champ => {
                const name = champMap[champ.championId] || `Champion-ID ${champ.championId}`;
                html += `<li>${name} (${champ.points} Punkte)</li>`;
            });
            html += '</ol>';
        }
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<p style="color:red;">Fehler beim Laden der Statistiken: ${err.message}</p>`;
    }
});
