// Robust, keyless, GitHub Pages tauglich.
const YT_HANDLE = (window.SOCIALS_CONFIG && window.SOCIALS_CONFIG.youtubeHandle) || "@Nirlau61";
const IG_USER   = (window.SOCIALS_CONFIG && window.SOCIALS_CONFIG.instagramUser) || "nirlau61";

async function xfetch(url) {
  const proxied = "https://r.jina.ai/http/" + url.replace(/^https?:\/\//, "");
  const res = await fetch(proxied, { headers: { "Accept": "text/html,application/xml" } });
  if (!res.ok) throw new Error(`Fetch ${url} -> ${res.status}`);
  return res.text();
}

/* ------------ YouTube: über /videos die erste watch?v=ID parsen ----------- */
async function loadLatestYouTube() {
  const mount = document.getElementById("youtube-latest");
  try {
    const html = await xfetch(`https://www.youtube.com/${encodeURIComponent(YT_HANDLE)}/videos`);
    // Finde die erste Video-ID (kommt mehrfach vor, deshalb global suchen)
    const m = html.match(/\/watch\?v=([0-9A-Za-z_-]{6,})/);
    if (!m) throw new Error("keine Video-ID gefunden");
    const videoId = m[1];
    // Titel optional
    const titleMatch = html.match(/"title":\s*\{"runs":\[\{"text":"([^"]{1,120})"/);
    const title = titleMatch ? titleMatch[1] : "YouTube Video";
    mount.innerHTML = `
      <div class="yt-16x9" aria-label="${title}">
        <iframe
          src="https://www.youtube.com/embed/${videoId}"
          title="${title}"
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen></iframe>
      </div>`;
  } catch (e) {
    console.error(e);
    mount.innerHTML = `<p class="error">Konnte YouTube nicht laden.</p>`;
  }
}

/* ------------ Instagram: shortcode suchen, sonst Link-Fallback ------------ */
async function loadLatestInstagram() {
  const mount = document.getElementById("instagram-latest");
  try {
    const html = await xfetch(`https://www.instagram.com/${encodeURIComponent(IG_USER)}/`);

    // 1) Primär: JSON-Feld "shortcode"
    let m = html.match(/"shortcode":"([0-9A-Za-z_-]{5,})"/);

    // 2) Fallback: erster Link /p/<id>/
    if (!m) m = html.match(/href="\/p\/([0-9A-Za-z_-]{5,})\//);

    const shortcode = m && m[1];
    if (!shortcode) throw new Error("kein Post gefunden");

    const postUrl = `https://www.instagram.com/p/${shortcode}/`;

    // Offizielles Embed-Markup; das externe Script rendert es.
    mount.innerHTML = `
      <blockquote class="instagram-media" data-instgrm-permalink="${postUrl}" data-instgrm-captioned="true" style="margin:0 auto;">
        <a href="${postUrl}" target="_blank" rel="noopener">Instagram Post</a>
      </blockquote>
    `;
    if (window.instgrm && window.instgrm.Embeds) window.instgrm.Embeds.process();
  } catch (e) {
    console.error(e);
    mount.innerHTML = `<p class="error">Konnte Instagram nicht laden.</p>`;
  }
}

/* Init */
loadLatestYouTube();
loadLatestInstagram();
