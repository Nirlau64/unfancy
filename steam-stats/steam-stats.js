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
  const dataAttrs = rest.map((url, i) => `data-src${i+1}="${url}"`).join(" ");
  return `
    <img src="${first}" alt="${alt}"
         style="width:184px;height:69px;object-fit:cover;border-radius:6px;box-shadow:0 2px 8px #000a;background:#111"
         onerror="
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
         "
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
    <div style="display:flex;align-items:center;gap:16px;">
      <img src="${profile.avatar}" alt="Avatar" style="width:64px;height:64px;border-radius:8px;">
      <div>
        <strong>${profile.persona}</strong><br>
        <a href="${profile.profileurl}" target="_blank" rel="noopener">Steam-Profil öffnen</a>
        ${profile.country ? `<br><span>Land: ${profile.country}</span>` : ""}
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
  const top = gamesFiltered
    .slice() // Kopie
    .sort((a,b) => b.playtime_minutes - a.playtime_minutes)
    .slice(0, 16);

  statsDiv.innerHTML = `
    <h2>Gesamtspielzeit: ${minutesToHours(totalMinutes)} Stunden</h2>
    <h3>Meistgespielte Spiele</h3>
    <div style="display:flex;flex-wrap:wrap;gap:24px;">
      ${top.map(game => {
        const imgs = buildImageCandidates(game.appid, game.img_logo_url);
        return `
          <div style="width:200px;text-align:center;">
            ${imgWithFallback(imgs, game.name)}
            <div style="margin-top:8px;font-weight:bold;">${game.name}</div>
            <div style="opacity:.8;">${minutesToHours(game.playtime_minutes)} Std.</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
});
