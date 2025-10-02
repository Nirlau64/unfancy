// lol-stats.js
// Fetches and displays League of Legends stats for Nirlau61#EUW from api.nirlau.de

document.addEventListener('DOMContentLoaded', async function() {
    const container = document.getElementById('lol-stats-container');
    container.innerHTML = '<p>Lade Statistiken ...</p>';

    try {
        // Passe ggf. den Endpoint an, falls dein Worker eine andere Route nutzt
        const response = await fetch('https://api.nirlau.de/lol/Nirlau61/EUW');
        if (!response.ok) throw new Error('Fehler beim Laden der Daten');
        const data = await response.json();

        // Beispielhafte Anzeige – passe an die Struktur deiner API an
        let html = '';
        html += `<h2>Summoner: ${data.summonerName || 'N/A'}</h2>`;
        html += `<p>Level: ${data.summonerLevel || 'N/A'}</p>`;
        if (data.rankedStats) {
            html += '<h3>Ranked Stats</h3>';
            html += `<ul>`;
            html += `<li>Tier: ${data.rankedStats.tier || 'N/A'} ${data.rankedStats.rank || ''}</li>`;
            html += `<li>LP: ${data.rankedStats.leaguePoints || 'N/A'}</li>`;
            html += `<li>Wins: ${data.rankedStats.wins || 'N/A'}</li>`;
            html += `<li>Losses: ${data.rankedStats.losses || 'N/A'}</li>`;
            if (data.rankedStats.wins && data.rankedStats.losses) {
                const winrate = (data.rankedStats.wins / (data.rankedStats.wins + data.rankedStats.losses) * 100).toFixed(1);
                html += `<li>Winrate: ${winrate}%</li>`;
            }
            html += `</ul>`;
        }
        if (data.mostPlayedChamps && data.mostPlayedChamps.length) {
            html += '<h3>Meistgespielte Champions</h3>';
            html += '<ol>';
            data.mostPlayedChamps.forEach(champ => {
                html += `<li>${champ.name} (${champ.games} Spiele, ${champ.winrate}% Winrate)</li>`;
            });
            html += '</ol>';
        }
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<p style="color:red;">Fehler beim Laden der Statistiken: ${err.message}</p>`;
    }
});
