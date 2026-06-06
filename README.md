# 🌟 Unfancy (nirlau.de)

**Unfancy** ist ein moderner, minimalistischer Statistik-Hub für Gaming-Daten, Musik und Social Media. Das Dashboard ist als performante **Fragment-SPA** mit Vanilla JavaScript realisiert und wird über GitHub Pages auf [nirlau.de](https://nirlau.de) gehostet.

---

## 🚀 Key Features

### ⚡ Fragment-SPA (Single Page Application)
Dank eines integrierten Vanilla JS Routers wechseln die Inhalte (Steam, Spotify, LoL) ohne harten Seitenumbruch. Die `index.html` dient als einzige App-Shell — alle Seiten-Inhalte werden als HTML-Fragmente aus `pages/` nachgeladen. Das sorgt für eine App-ähnliche Experience bei gleichzeitig zentraler Wartung von Header, Navigation und Footer.

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
├── index.html           # App-Shell (einzige vollständige HTML-Seite)
├── 404.html             # Gestylte Fehlerseite
├── style.css            # Globale Styles & Transition-Definitionen
├── CNAME                # GitHub Pages Custom Domain (nirlau.de)
├── pages/               # HTML Content-Fragmente (kein <head>/<body>)
│   ├── home.html
│   ├── steam.html
│   ├── spotify.html
│   ├── lol.html
│   └── socials.html
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
│   └── favicon.png      # Favicon
├── steam.html           # Redirect-Stub → /?page=steam
├── spotify.html         # Redirect-Stub → /?page=spotify
├── lol.html             # Redirect-Stub → /?page=lol
└── socials.html         # Redirect-Stub → /?page=socials
```

---

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
