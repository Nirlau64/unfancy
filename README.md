# 🌟 Unfancy (nirlau.de)

**Unfancy** ist ein moderner, minimalistischer Statistik-Hub für Gaming-Daten, Musik und Social Media. Das Dashboard ist als performante **App-Shell** mit Vanilla JavaScript realisiert und wird über GitHub Pages auf [nirlau.de](https://nirlau.de) gehostet.

---

## 🚀 Key Features

### ⚡ Flüssige Navigation (PJAX)
Dank eines integrierten Vanilla JS Routers wechseln die Inhalte (Steam, Spotify, LoL) ohne harten Seitenumbruch. Das sorgt für eine App-ähnliche Experience bei gleichzeitig voller SEO-Kompatibilität durch separate HTML-Fragmente.

### 🎨 Dynamisches Theming & UX
*   **Adaptive Akzentfarben:** Die gesamte Website passt ihre Akzentfarbe (`--accent`) in Echtzeit an das Album-Cover deines aktuellen Spotify-Songs an.
*   **Interaktive Splash-Hintergründe:** Beim Hovern über Spiele (Steam), Künstler (Spotify) oder Match-Einträge (LoL) erscheint weich geblendet das passende Artwork im Hintergrund der Sektion.
*   **Dark-First Design:** Ein konsequentes, augenschonendes Dark-Theme mit CSS-Variablen.

### 🎮 Gaming Insights
*   **League of Legends:** Detaillierte Summoner-Stats, Top-Champions und Match-Historie direkt von der Riot API (via Cloudflare Proxy). Inklusive Champion-Splash-Art-Vorschauen.
*   **Steam Integration:** Visualisierung der Gesamtspielzeit (Chart.js) und interaktive Grid-Ansicht der meistgespielten Titel inklusive gefilterter Blocklist für Tools/Software.

### 🎵 Musik & Lifestyle
*   **Spotify Real-Time:** Live-Anzeige des aktuellen Tracks und personalisierte Grids deiner Top-Künstler und Titel (4 Wochen bis 1 Jahr).
*   **Socials Directory:** Ein integriertes Verzeichnis deiner Kanäle inklusive automatischem YouTube-Embed deines neuesten Videos.

---

## 🛠 Tech Stack

*   **Frontend:** HTML5, CSS3, Vanilla JavaScript (ES6+).
*   **Visualisierung:** [Chart.js](https://www.chartjs.org/) für Gaming-Statistiken.
*   **API-Infrastruktur:** [Cloudflare Workers](https://workers.cloudflare.com/) als sichere Proxy-Layer für Riot-, Steam- und Spotify-Anbindungen.
*   **Hosting:** GitHub Pages mit Custom Domain.

---

## 📂 Projektstruktur

Das Projekt wurde von einer Verzeichnis-basierten Struktur auf eine modulare **Single-Level-Architektur** refactored:

```text
unfancy/
├── index.html       # App-Shell & Home Content
├── lol.html         # LoL Statistik Fragment
├── steam.html       # Steam Statistik Fragment
├── spotify.html     # Spotify Integration Fragment
├── socials.html     # Social-Media & YouTube Video
├── script.js        # Zentraler Router, API-Logik & Farbanalyse
├── style.css        # Globale Styles & Transition-Definitionen
└── GEMINI.md        # AI Context & Architektur-Guide
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
© 2026 Unfancy - Laurin
