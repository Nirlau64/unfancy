# 🌟 Unfancy (nirlau.de)

**Unfancy** ist ein minimalistischer, persönlicher Statistik-Hub. Die App dient als zentrales Dashboard für Gaming-Daten, Musik-Aktivitäten und Social-Media-Präsenz – direkt gehostet über GitHub Pages auf [nirlau.de](https://nirlau.de).

---

## 🚀 Features

### 🎮 Gaming Stats
*   **League of Legends:** Echtzeit-Anzeige von Match-Historien, Sieg/Niederlage-Statistiken und Summoner-Informationen. Die Abfrage erfolgt sicher über einen dedizierten **Cloudflare Worker API-Proxy**.
*   **Steam Integration:** Dynamische Karten-Layouts für Spielzeiten und zuletzt gespielte Titel.

### 🎵 Musik & Lifestyle
*   **Spotify Real-Time:** Anzeige des aktuell gehörten Songs und der Lieblingskünstler direkt über die Spotify-Web-API.
*   **Minimalist Socials:** Ein responsives Verzeichnis aller aktuellen Social-Media-Kanäle in einem klaren "Link-in-Bio"-Stil.

### 🎨 Design & UX
*   **Dark-First:** Ein konsistentes Dark-Theme für beste Lesbarkeit.
*   **Responsive:** Vollständig optimiert für mobile Endgeräte und Desktop-Browser.
*   **Vanilla-Fokus:** Verzicht auf schwere Frameworks für maximale Performance.

---

## 🛠 Tech Stack

*   **Frontend:** HTML5, CSS3 (Custom Properties), Vanilla JavaScript (ES6+).
*   **Backend/Proxy:** Cloudflare Workers (Riot API Bridge).
*   **Hosting:** GitHub Pages (nirlau.de).
*   **APIs:** 
    *   Riot Games API (via Proxy)
    *   Steam Web API
    *   Spotify Web API

---

## 📂 Projektstruktur

```text
unfancy/
├── lol-stats/           # League of Legends Logik & Styles
├── steam-stats/         # Steam API Integration & Layouts
├── spotify-stats/       # Spotify Real-Time Display
├── social/              # Social-Media Verzeichnis
├── assets/              # Bilder, Icons & globale Styles
├── index.html           # Haupteinstiegspunkt
└── CNAME                # Domain-Konfiguration (nirlau.de)
```

---

## 💻 Lokale Entwicklung

Da das Projekt rein statisch ist, kann es ohne Build-Schritte gestartet werden.

1.  Repository klonen:
    ```bash
    git clone https://github.com/Nirlau64/unfancy.git
    ```
2.  Lokal hosten (Beispiel mit Python):
    ```bash
    python3 -m http.server 8080
    ```
3.  Im Browser öffnen: `http://localhost:8080`

*Hinweis: Einige API-Features erfordern gültige API-Keys oder den konfigurierten Cloudflare-Proxy, um lokal vollständig zu funktionieren.*

---
