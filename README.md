# Unfancy — Persönliche Stats-Website

**Unfancy** ist eine kleine, persönliche Web-App zum Sammeln und Anzeigen meiner Spieler-Statistiken.  
Das Projekt besteht aus statischen **HTML**, **CSS** und **JavaScript**-Dateien und wird über **GitHub Pages** auf  
[**nirlau.de**](https://nirlau.de) gehostet.  

Neben der Startseite gibt es spezielle Unterseiten für:
- 🎮 **League of Legends Stats** → `lol-stats/`
- 🕹️ **Steam Stats** → `steam-stats/`
- 🌐 **Socials (YouTube, Instagram, etc.)** → `socials/`

---

## 🧩 Features

- **League of Legends-Statistiken**
  - Zeigt Matchhistorie, Sieg/Niederlage und Summoner-Infos.
  - Nutzt einen eigenen Cloudflare-Worker als Proxy zur Riot-API.
  - Plant Unterstützung für Arena-Platzierungen und Challenges.

- **Steam-Statistiken**
  - Liest über eine API persönliche Spieldaten (Playtime, Achievements, etc.) aus.
  - Präsentiert Spiele in flexiblen, anpassbaren Kartenlayouts.

- **Social-Seite**
  - Verlinkt auf aktuelle Social-Media-Kanäle.
  - Minimalistisches, responsives Layout.

---

## 🛠️ Aufbau des Projekts


unfancy/
├── index.html              # Startseite
├── style.css               # Haupt-Stylesheet
├── script.js               # allgemeine Logik & Effekte
│
├── lol-stats/              # League-of-Legends-Stats
│   ├── index.html
│   └── lol-stats.js
│
├── steam-stats/            # Steam-Statistiken
│   ├── index.html
│   └── steam-stats.js
│
└── socials/                # Social-Links
├── index.html
└── socials.js


---

## 🚀 Lokal ausführen

Da das Projekt rein statisch ist, reicht es, den Ordner lokal zu öffnen oder über einen simplen lokalen Server zu starten:

```bash
# Mit Python:
python3 -m http.server 8080
````

Dann im Browser aufrufen:
👉 [http://localhost:8080](http://localhost:8080)

---

## 🌈 Design

* Modernes Dark-Theme mit akzentuierten Farben
* Klare, zentrierte Layoutstruktur
* Mobile-Friendly mit flexiblen Kartenkomponenten

---

## 📄 Lizenz

Kein kommerzielles Projekt.
© 2025 Laurin — alle Rechte vorbehalten.

---

