// SteamID64 und API-URL anpassen!
const STEAMID = "76561198159661156"; // z.B. "76561198012345678"
const API = "https://steam.api.nirlau.de";

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

  // Profil laden
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
        <a href="${profile.profileurl}" target="_blank">Steam-Profil öffnen</a>
        ${profile.country ? `<br><span>Land: ${profile.country}</span>` : ""}
      </div>
    </div>
    <hr>
  `;

  // Spiele laden
  const owned = await fetchOwned();
  if (owned.error) {
    statsDiv.innerHTML = `<p>Fehler beim Laden der Spiele: ${owned.error}</p>`;
    return;
  }
  statsDiv.innerHTML = `
    <h2>Gesamtspielzeit: ${minutesToHours(owned.total_minutes)} Stunden</h2>
    <h3>Meistgespielte Spiele</h3>
    <div style="display:flex;flex-wrap:wrap;gap:24px;">
      ${owned.games.slice(0, 10).map(game => `
        <div style="width:140px;text-align:center;">
          <img src="https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${game.appid}/${game.img_logo_url}.jpg"
               alt="${game.name}" style="width:120px;height:45px;object-fit:cover;border-radius:6px;box-shadow:0 2px 8px #000a;">
          <div style="margin-top:8px;font-weight:bold;">${game.name}</div>
          <div style="color:#7dd3fc;">${minutesToHours(game.playtime_minutes)} Std.</div>
        </div>
      `).join("")}
    </div>
  `;
});