# 🌟 Unfancy (nirlau.de)

**Unfancy** ist ein moderner, minimalistischer Statistik-Hub für Gaming-Daten, Musik und Social Media. Das Dashboard ist als performante **Fragment-SPA** mit Vanilla JavaScript realisiert und wird über GitHub Pages auf [nirlau.de](https://nirlau.de) gehostet.

---

## 🚀 Key Features

### ⚡ Fragment-SPA (Single Page Application)
Dank eines integrierten Vanilla JS Routers wechseln die Inhalte (Steam, Spotify, LoL) ohne harten Seitenumbruch. `index.html` und `pages/` sind die handgeschriebenen Quellen; der Generator erzeugt daraus vollständige Bereichsseiten unter `/steam/`, `/spotify/`, `/lol/` und `/socials/`. Direktaufrufe enthalten bereits statischen Inhalt, weitere Navigation lädt Fragmente nach. Header, Navigation und Footer bleiben zentral wartbar.

### 🎨 Dynamisches Theming & UX
*   **Adaptive Akzentfarben:** Die gesamte Website passt ihre Akzentfarbe (`--accent`) in Echtzeit an das Album-Cover deines aktuellen Spotify-Songs an.
*   **Interaktive Splash-Hintergründe:** Beim Hovern über Spiele (Steam), Künstler (Spotify) oder Match-Einträge (LoL) erscheint weich geblendet das passende Artwork im Hintergrund der Sektion.
*   **Dark-First Design:** Ein konsequentes, augenschonendes Dark-Theme mit CSS-Variablen.

### 🔒 Sicherheit
*   **Content Security Policy (CSP):** Einschränkung der erlaubten Script-, Style-, Frame- und Connect-Quellen via `<meta>`-Tag.
*   **DOM-basiertes Rendering:** Alle API-Daten werden per `createElement`/`textContent` gerendert — kein `innerHTML` mit unsanitisierten Daten.
*   **`rel="noopener noreferrer"`:** Auf allen externen Links mit `target="_blank"`.

### 🎮 Gaming Insights
*   **League of Legends:** Detaillierte Summoner-Stats, Top-Champions und Match-Historie direkt von der Riot API (via Cloudflare Proxy). Inklusive Champion-Splash-Art-Vorschauen.
*   **Steam Integration:** Visualisierung der Gesamtspielzeit (Chart.js — lazy-loaded) und interaktive Grid-Ansicht der meistgespielten Titel inklusive gefilterter Blocklist für Tools/Software.

### 🎵 Musik & Lifestyle
*   **Spotify Real-Time:** Live-Anzeige des aktuellen Tracks und personalisierte Grids deiner Top-Künstler und Titel (4 Wochen bis 1 Jahr).
*   **Socials Directory:** Ein integriertes Verzeichnis deiner Kanäle inklusive automatischem YouTube-Embed deines neuesten Videos.

---

## 🛠 Tech Stack

*   **Frontend:** HTML5, CSS3, Vanilla JavaScript (ES6+ Modules).
*   **Visualisierung:** [Chart.js](https://www.chartjs.org/) für Gaming-Statistiken (dynamisch geladen, nur auf der Steam-Seite).
*   **API-Infrastruktur:** [Cloudflare Workers](https://workers.cloudflare.com/) als sichere Proxy-Layer für Riot-, Steam- und Spotify-Anbindungen.
*   **Hosting:** GitHub Pages mit Custom Domain.

---

## 📂 Projektstruktur

```text
unfancy/
├── index.html           # App-Shell (einzige vollständige, handgeschriebene HTML-Seite)
├── 404.html             # Gestylte Fehlerseite (noindex,nofollow)
├── style.css            # Globale Styles & Transition-Definitionen
├── CNAME                # GitHub Pages Custom Domain (nirlau.de)
├── _headers             # Header-Vorlage; GitHub Pages wertet diese Datei NICHT aus
├── manifest.json        # PWA-Manifest (favicon-64/icon-192/icon-512)
├── sw.js                # Service Worker (unfancy-v7, keine API-Persistenz)
├── sitemap.xml          # Kanonische öffentliche Routen
├── robots.txt           # Verweist auf die Sitemap
├── pages/               # HTML Content-Fragmente (kein <head>/<body>)
│   ├── home.html
│   ├── steam.html
│   ├── spotify.html
│   ├── lol.html
│   └── socials.html
├── steam/ … socials/    # Generierte statische Routen → <route>/index.html
├── js/                  # ES6 Module
│   ├── main.js          # Entry Point, Navigation-Handler, Polling
│   ├── router.js        # Fragment-Router, History API, Swipe-Navigation
│   ├── api.js           # Fetch-Wrapper mit Cache-Busting & AbortSignal
│   ├── utils.js         # Config, Farbanalyse, escapeHTML, Splash-Hover
│   └── views/           # View Controller (je Seite)
│       ├── home.js      # Live-Status (Spotify + Steam)
│       ├── steam.js     # Profil, Games, Achievements, Chart
│       ├── spotify.js   # Top Artists, Tracks, Now Playing
│       ├── lol.js       # Summoner, Champions, Match-History
│       └── socials.js   # YouTube Embed, Instagram Embed
├── assets/
│   ├── icon-source.png          # Versionierte Master-Grafik (512×512) für alle Icons
│   ├── favicon-64.png           # Kleines Favicon
│   ├── icon-192.png             # PWA-Icon 192px
│   ├── icon-512.png             # PWA-/OG-Icon 512px
│   ├── apple-touch-icon.png     # 180×180
│   └── vendor/
│       ├── LICENSE.chartjs.txt      # MIT-Lizenz Chart.js
│       ├── LICENSE.kurkle-color.txt # MIT-Lizenz @kurkle/color
│       └── chart.umd.js             # Chart.js 4.4.7 (lokal gepinnt, kein CDN)
├── workers/             # Cloudflare Worker (Spotify-Auth/-Proxy, Riot-, Steam-Proxy)
├── tests/               # node:test-Suite (inkl. Drift-/Whitespace-Checks)
├── docs/                # Härtungs- und Cloudflare-Write-Plan-Dokumentation
└── scripts/
    ├── build-routes.mjs # Erzeugt die statischen Routen (node scripts/build-routes.mjs)
    ├── make-icons.py    # Erzeugt die optimierten Icons aus assets/icon-source.png
    └── e2e-browser.mjs  # Browser-Regression (Service-Worker, Router) via CDP
```

Die statischen Routen werden aus `index.html` + `pages/*.html` generiert. Nach
Änderungen an der Shell oder Fragmenten: `node scripts/build-routes.mjs` ausführen
und die generierten Seiten mitcommitten. Ein Drift-Check in
`tests/static-routes.test.mjs` schlägt fehl, wenn die committeten Seiten nicht
mehr zum Generator-Stand passen.

Die Icons werden reproduzierbar aus der versionierten Quelle
`assets/icon-source.png` erzeugt (`python3 scripts/make-icons.py`, benötigt
Pillow). Nach Änderungen an Quelle oder Skript neu generieren und die PNGs
mitcommitten — bei gleicher Pillow-Version sind die Ausgaben byte-identisch.

---

## Veröffentlichung und getrennte Rollouts

Das Frontend wird von GitHub Pages aus `main` veröffentlicht. Der letzte vor der
Wiederaufnahme bestätigte Pages-Deploy ist `57cd802` (10.11.2026). Ein Push von
Worker-Quellen deployt **keine** Cloudflare-Worker: deren Uploads, Bindings,
Migrationen und Rollback benötigen einen separat geprüften Rollout.

`_headers` ist lediglich eine Vorlage für kompatible Hosts. Auf GitHub Pages
aktiviert sie weder CSP-Report-Only noch andere HTTP-Sicherheitsheader. Das bereits
aktive HSTS wird durch Cloudflare gesetzt und bleibt bei diesem Frontend-Release
unverändert. Offene Edge-/Worker-Schritte stehen in
[`docs/high-impact-hardening.md`](docs/high-impact-hardening.md).

## 💻 Lokale Entwicklung

Das Projekt ist rein statisch. Um die AJAX-Übergänge und CORS-Features (wie Farberkennung) lokal zu testen, wird ein lokaler Webserver empfohlen:

1.  **Repository klonen**
2.  **Server starten:**
    ```bash
    npx serve .
    # oder
    python3 -m http.server
    ```
3.  **Hinweis:** Die Spotify-Farberkennung erfordert eine aktive Domain/Origin, um CORS-Blockaden bei Canvas-Operationen zu vermeiden.

---
© Unfancy - Laurin
