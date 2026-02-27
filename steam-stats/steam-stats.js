// SteamID64 und API-URL anpassen!
const STEAMID = "76561198159661156";
const API = "https://steam.api.nirlau.de";

// --- Filter: Tools ausschließen (Schwerpunkt: Soundpad & Co.) ---
const BLOCKLIST_APPIDS = new Set([
  629520,   // Soundpad
  744190,   // Soundpad Demo
  431960,   // Wallpaper Engine
  250820,   // SteamVR
  228980,   // Steamworks Common Redistributables
  480       // Spacewar (Test-App)
]);

const BLOCKLIST_NAME_PATTERNS = [
  /soundpad/i,
  /wallpaper\s*engine/i,
  /steamvr/i,
  /redistributables/i,
  /benchmark/i,
  /sdk\b/i,
  /\beditor\b/i,
  /tool/i,
  /server/i,
  /soundtrack/i,
  /demo\b/i,
  /playtest/i,
  /test\b/i
];

function isBlocked(game) {
  if (BLOCKLIST_APPIDS.has(game.appid)) return true;
  const name = game.name || "";
  return BLOCKLIST_NAME_PATTERNS.some(rx => rx.test(name));
}

// --- Bildquellen: store header → store capsule → community logo ---
function buildImageCandidates(appid, img_logo_url) {
  const list = [
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_231x87.jpg`
  ];
  if (img_logo_url) {
    list.push(`https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${img_logo_url}.jpg`);
  }
  return list;
}

function imgWithFallback(candidates, alt) {
  const first = candidates[0];
  const rest = candidates.slice(1);
  // wir nutzen data-src-N für Kaskade
  const dataAttrs = rest.map((url, i) => `data-src${i+1}=\"${url}\"`).join(" ");
  return `
    <img src=\"${first}\" alt=\"${alt}\"
         style=\"width:184px;height:69px;object-fit:cover;border-radius:6px;box-shadow:0 2px 8px #000a;background:#111\"
         onerror=\"
           const el=this;
           const tryNext=()=>{
             const keys=[...el.attributes].map(a=>a.name).filter(n=>n.startsWith('data-src'));
             if(keys.length===0){ el.onerror=null; return; }
             keys.sort(); // data-src1, data-src2,...
             const nextKey=keys[0];
             const next=el.getAttribute(nextKey);
             el.removeAttribute(nextKey);
             el.src=next;
           };
           tryNext();
         \"
         ${dataAttrs}
    >
  `;
}

async function fetchProfile() {
  const res = await fetch(`${API}/profile?steamid=${STEAMID}`);
  return res.json();
}

async function fetchOwned() {
  const res = await fetch(`${API}/owned?steamid=${STEAMID}`);
  return res.json();
}

function minutesToHours(min) {
  return (min / 60).toFixed(1);
}

document.addEventListener("DOMContentLoaded", async () => {
  const profileDiv = document.getElementById("steam-profile");
  const statsDiv = document.getElementById("steam-stats-container");

  // Profil
  const profile = await fetchProfile();
  if (profile.error) {
    profileDiv.innerHTML = `<p>Fehler beim Laden des Profils: ${profile.error}</p>`;
    return;
  }
  profileDiv.innerHTML = `
    <div style=\"display:flex;align-items:center;gap:16px;\">
      <img src=\"${profile.avatar}\" alt=\"Avatar\" style=\"width:64px;height:64px;border-radius:8px;\">
      <div>
        <strong>${profile.persona}</strong><br>
        <a href=\"${profile.profileurl}\" target=\"_blank\" rel=\"noopener\">Steam-Profil öffnen</a>
        ${profile.country ? `<span>Land: ${profile.country}</span>` : ""}
      </div>
    </div>
    <hr>
  `;

  // Spiele
  const owned = await fetchOwned();
  if (owned.error) {
    statsDiv.innerHTML = `<p>Fehler beim Laden der Spiele: ${owned.error}</p>`;
    return;
  }

  // Tools rausfiltern
  const gamesFiltered = (owned.games || []).filter(g => !isBlocked(g));

  const totalMinutes = gamesFiltered.reduce((s, g) => s + (g.playtime_minutes || 0), 0);
  const top16 = gamesFiltered
    .slice() // Kopie
    .sort((a,b) => b.playtime_minutes - a.playtime_minutes)
    .slice(0, 16);

  const top10 = top16.slice(0, 10);
  const top10Minutes = top10.reduce((sum, game) => sum + game.playtime_minutes, 0);
  const otherMinutes = totalMinutes - top10Minutes;

statsDiv.innerHTML = `
  <h2>Gesamtspielzeit: ${minutesToHours(totalMinutes)} Stunden</h2>
  <h3>Meistgespielte Spiele</h3>
  <div style=\"display:grid;
              grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
              gap:16px;
              justify-items:center;\">
    ${top16.map(game => {
       const imgs = buildImageCandidates(game.appid, game.img_logo_url);
       return `
         <div style=\"text-align:center;width:100%;max-width:220px;\">
           ${imgWithFallback(imgs, game.name)}
           <div style=\"margin-top:8px;font-weight:bold;\">${game.name}</div>
           <div style=\"opacity:.8;\">${minutesToHours(game.playtime_minutes)} Std.</div>
         </div>`;
     }).join("")}
  </div>`;

  const chartCanvas = document.getElementById('top-games-chart');

  const generateColors = (count) => {
    const colors = [];
    const baseColors = [
        '#7dd3fc', '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e',
        '#f97316', '#facc15', '#4ade80', '#2dd4bf', '#a3e635'
    ];
    for (let i = 0; i < count; i++) {
        colors.push(baseColors[i % baseColors.length]);
    }
    return colors;
  };

  const getOrCreateTooltip = (chart) => {
      let tooltipEl = chart.canvas.parentNode.querySelector('div.chartjs-tooltip');
      if (!tooltipEl) {
          tooltipEl = document.createElement('div');
          tooltipEl.classList.add('chartjs-tooltip');
          tooltipEl.style.background = 'rgba(20, 22, 28, 0.9)';
          tooltipEl.style.borderRadius = '8px';
          tooltipEl.style.color = 'white';
          tooltipEl.style.opacity = 1;
          tooltipEl.style.pointerEvents = 'none';
          tooltipEl.style.position = 'absolute';
          tooltipEl.style.transform = 'translate(-50%, -110%)';
          tooltipEl.style.transition = 'all .2s ease';
          tooltipEl.style.padding = '12px';
          tooltipEl.style.boxShadow = '0 4px 16px #000a';
          tooltipEl.style.textAlign = 'center';
          tooltipEl.style.border = '1px solid #2d313d';

          const container = document.createElement('div');
          tooltipEl.appendChild(container);
          chart.canvas.parentNode.appendChild(tooltipEl);
      }
      return tooltipEl;
  };

  const externalTooltipHandler = (context) => {
      const { chart, tooltip } = context;
      const tooltipEl = getOrCreateTooltip(chart);

      if (tooltip.opacity === 0) {
          tooltipEl.style.opacity = 0;
          return;
      }

      const tooltipContent = tooltipEl.querySelector('div');

      if (tooltip.body) {
          const dataIndex = tooltip.dataPoints[0].dataIndex;
          const label = chart.data.labels[dataIndex];
          const value = chart.data.datasets[0].data[dataIndex];
          const hours = minutesToHours(value);

          if (label === 'Andere') {
              tooltipContent.innerHTML = `
                  <div style=\"font-weight:bold;color:#f1f1f1;padding:8px;\">Andere Spiele</div>
                  <div style=\"opacity:.8;font-size:0.9em;padding:0 8px 8px;\">${hours} Std.</div>
              `;
          } else {
              const game = top10[dataIndex];
              if (game) {
                  const imgs = buildImageCandidates(game.appid, game.img_logo_url);
                  tooltipContent.innerHTML = `
                      ${imgWithFallback(imgs, game.name)}
                      <div style=\"margin-top:8px;font-weight:bold;color:#f1f1f1;\">${game.name}</div>
                      <div style=\"opacity:.8;font-size:0.9em;\">${hours} Std.</div>
                  `;
              }
          }
      }

      const { offsetLeft: positionX, offsetTop: positionY } = chart.canvas;
      tooltipEl.style.opacity = 1;
      tooltipEl.style.left = positionX + tooltip.caretX + 'px';
      tooltipEl.style.top = positionY + tooltip.caretY + 'px';
  };
  
  const chartLabels = [...top10.map(g => g.name), 'Andere'];
  const chartData = [...top10.map(g => g.playtime_minutes), otherMinutes];
  const chartColors = [...generateColors(top10.length), '#6b7280'];

  new Chart(chartCanvas, {
    type: 'pie',
    data: {
      labels: chartLabels,
      datasets: [{
        label: 'Spielstunden',
        data: chartData,
        backgroundColor: chartColors,
        borderColor: '#181a20',
        borderWidth: 2,
        hoverOffset: 10
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: 'white',
            padding: 20,
            font: {
              size: 12
            }
          }
        },
        tooltip: {
          enabled: false,
          external: externalTooltipHandler
        }
      }
    }
  });
});
