# Unfancy: High-Impact-Härtung — Umsetzungsstand 22.11.2026

Branch `task/high-impact-unfancy` (auf `origin/main` `57cd802`); Frontend-Änderungen getestet (52/52 `node --test tests/*.test.mjs`), Browser-Checks gegen einen lokalen HTTP-Server (Chromium headless). Produktions-Deploy (Merge auf `main`) steht noch aus.

## Umgesetzt (Frontend)

- **Statische, crawlbare Routen** `/steam/`, `/spotify/`, `/lol/`, `/socials/` werden aus der Shell und den Fragmenten generiert (`node scripts/build-routes.mjs`); jede Seite mit eigenem Title, Description, Canonical, OG/Twitter und `data-static-page`-Marker. Query-Kompatibilität (`/?page=…`) bleibt erhalten; der Router löst zusätzlich Clean-Path-Deep-Links auf (`js/router.js`). `js/main.js` setzt jetzt seitenbezogene Titles statt des generischen Dashboard-Titels (im Browser verifiziert).
- **SEO-Grundlagen:** `sitemap.xml` mit genau den fünf kanonischen Routen; `robots.txt` verweist darauf; `404.html` ist `noindex,nofollow`.
- **Icons:** `favicon.png` (4,69 MB) entfernt; ersetzt durch quantisierte `favicon-64.png` (2,2 KB), `icon-192.png` (6,8 KB), `icon-512.png` (31 KB), `apple-touch-icon.png` (6,2 KB) – zusammen 46,5 KB. Manifest-Größen korrigiert. Generierung: `scripts/make-icons.py` (Pillow).
- **Steam/Chart-Lifecycle:** Chart.js **4.4.7 lokal** (`assets/vendor/chart.umd.js`), kein CDN mehr; Laden nur nach erfolgreichem Datenrender, 5-s-Timeout, Detached-Canvas-Guard; CDN-Quelle aus der Meta-CSP entfernt. Service Worker `unfancy-v7`: precached statische Routen/Icons/Chart-Bundle, persistiert **keine** API-Antworten mehr, API-Fetches mit `no-store`.
- **Worker-Härtung versioniert:** `workers/{spotify-auth,spotify-proxy,riot-proxy,steam-proxy}.js` mit negativen Tests (`tests/workers-hardening.test.mjs`): OAuth-Host-Allowlist + fester Callback (`spotify-auth`), Methoden-/Pfad-/Input-Allowlists, CORS nur für erlaubte Origins (+`Vary: Origin`), Colo-lokales Best-Effort-Rate-Limit (30/60s pro IP+Pfadsegment, fail-open), `no-store` auf Fehler-/429-Antworten, `/refresh-check`-Diagnostik (Header-gated). **Noch nicht deployed** – siehe unten.

## Cloudflare

- **W4 umgesetzt und live verifiziert:** Zone-Settings `security_header` auf HSTS `max-age=15552000`, `include_subdomains=false`, `preload=false`, `nosniff=false` (unverändert). Settings-Readback exakt Soll; Live-Header-Check auf `nirlau.de`, `www.nirlau.de` und `steam.api.nirlau.de` zeigt `max-age=15552000` ohne `includeSubDomains`/Preload. Rollback: `{max_age=0, include_subdomains=true, …}` (clientseitige Rollback-Grenze dokumentiert). `nosniff` bleibt ausdrücklich offener Punkt.
- **W0–W3, W5 offen (BLOCKIEREND im Review-Loop):** Der unabhängige Reviewer (GPT-6.2-sol) hat den Write-Plan für Worker-Deploys, Binding-Entfernung und Observability-Änderungen in sechs Runden nicht freigegeben; der aktuelle Plan (`docs/cloudflare-write-plan.md`) inkl. W0-Semantikprobe ist vorbereitet, aber nicht ausgeführt. Kein Worker-Write, kein Binding-Write, kein Observability-Write ist erfolgt.
- **Nicht möglich mit vorhandenem Token (Blocker):** CSP-Report-Only und weitere Edge-Header (Zone Transform Rules/Rulesets Write fehlt, Read-Probe 403), zonenweite Rate-Limiting-/Abuse-Regeln (403), Observability-Retention (separates Recht). **Kein Rechteausweitung, kein neuer Token.**
- **Refresh-Token unangetastet:** nicht gelesen, rotiert, widerrufen oder ersetzt. Nirlau rotiert/reautorisiert nach Abschluss selbst; das redundante `SPOTIFY_REFRESH_TOKEN`-Plain-Binding existiert live weiterhin (Entfernung = W2, offen).
- CSP-Report-Only ist **nicht** aktiv; die Meta-CSP ersetzt keine Edge-Header-Funktionen.

## Offene Punkte (konkret)

1. W0–W5 gemäß `docs/cloudflare-write-plan.md` ausführen (benötigt GO des Reviewers; W0-Probe beweist Upload/PATCH/Rollback-Semantik empirisch).
2. Frontend-Deploy: Merge von `task/high-impact-unfancy` auf `main` (GitHub Pages) und Live-Wiederholung der Routen-/Sitemap-/Header-Checks.
3. `nosniff` (zonenweit) und CSP-Report-Only: eigenes Review + Rechte (Zone Transform Rules/Rulesets Write).
4. Zonenweite Rate-Limiting-Regeln: Rechte fehlen.
5. Spotify-Refresh-Token-Rotation/Reautorisierung durch Nirlau nach Abschluss; danach KV als alleinige Quelle bestätigt lassen.

Keine CWV-/SEO-Wirkung behauptet – es liegen keine Feld-/Labormessungen vor; gemessen wurden nur funktionale Abnahmekriterien (Tests, HTTP- und Browser-Checks).
