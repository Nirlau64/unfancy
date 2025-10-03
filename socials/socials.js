/* Minimal, keyless. Nutzt r.jina.ai als CORS-freundlichen Fetcher. */
const YT_HANDLE = window.SOCIALS_CONFIG?.youtubeHandle || "@Nirlau61";
const IG_USER   = window.SOCIALS_CONFIG?.instagramUser || "nirlau61";

/* Hilfsfetch über r.jina.ai, um CORS zu vermeiden. */
async function xfetch(url) {
  const proxied = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`;
  const res = await fetch(proxied, { headers: { "Accept": "text/html,application/xml" } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.text();
}

/* -------- YouTube: neuestes Video über Handle -> ChannelID -> RSS -------- */
async function loadLatestYouTube() {
  const mount = document.getElementById("youtube-latest");
  try {
    // 1) Handle-Seite holen und channelId herausziehen
    const html = await xfetch(`https://www.youtube.com/${encodeURIComponent(YT_HANDLE)}`);
    const channelId = (html.match(/"channelId":"(UC[0-9A-Za-z_-]{22})"/) || [])[1];
    if (!channelId) throw new Error("channelId nicht gefunden");

    // 2) RSS der Uploads ziehen und erstes Video bestimmen
    const rss = await xfetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    const doc = new DOMParser().parseFromString(rss, "application/xml");
    const firstEntry = doc.querySelector("entry");
    if (!firstEntry) throw new Error("Keine Videos gefunden");
    const videoId = firstEntry.querySelector("yt\\:videoId, videoId")?.textContent?.trim();
    const title = firstEntry.querySelector("title")?.textContent ?? "Video";

    // 3) Einbetten
    mount.innerHTML = `
      <div class="yt-16x9" aria-label="${title}">
        <iframe
          src="https://www.youtube.com/embed/${videoId}"
          title="${title}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen loading="lazy"></iframe>
      </div>
    `;
  } catch (err) {
    console.error(err);
    mount.innerHTML = `<p class="error">Konnte YouTube nicht laden.</p>`;
  }
}

/* -------- Instagram: neuester Post via öffentliche Profilseite -------- */
async function loadLatestInstagram() {
  const mount = document.getElementById("instagram-latest");
  try {
    // 1) Profil-HTML holen
    const html = await xfetch(`https://www.instagram.com/${encodeURIComponent(IG_USER)}/`);

    // 2) Shortcode des neuesten Posts parsen
    // Suche nach "shortcode":"XXXXXX"
    const m = html.match(/"shortcode":"([0-9A-Za-z_-]{5,})"/);
    const shortcode = m && m[1];
    if (!shortcode) throw new Error("Kein Post gefunden");

    const postUrl = `https://www.instagram.com/p/${shortcode}/`;

    // 3) Offizielles Embed-Markup erzeugen; Instagram JS rendert das.
    mount.innerHTML = `
      <blockquote class="instagram-media" data-instgrm-permalink="${postUrl}" data-instgrm-captioned="true" style="margin:0 auto;">
        <a href="${postUrl}" target="_blank" rel="noopener">Instagram Post</a>
      </blockquote>
    `;

    // 4) Re-parse triggern, falls embed.js bereits geladen ist
    if (window.instgrm && window.instgrm.Embeds) {
      window.instgrm.Embeds.process();
    }
  } catch (err) {
    console.error(err);
    mount.innerHTML = `<p class="error">Konnte Instagram nicht laden.</p>`;
  }
}

/* Init */
loadLatestYouTube();
loadLatestInstagram();
