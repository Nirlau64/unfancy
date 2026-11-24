# Unfancy: High-Impact-Härtung

## Wiederaufnahme 24.11.2026 — maßgeblicher Release-Scope

- Zusammengeführte Quellbasis: `6dcdd25`, 73/73 Node-Tests am 24.11. erneut bestanden; Browser-E2E ebenfalls bestanden. Die zusätzliche EOF-Leerzeile in `tests/docs-consistency.test.mjs` wurde für den Release entfernt, da der vollständige Diff gegen `origin/main` sonst den Whitespace-Check nicht besteht.
- Frontend und Worker sind getrennte Rollouts. `nirlau.de` wird nachweislich von **GitHub Pages** aus `main` ausgeliefert (GitHub-Deployment `7690910494` auf `57cd802`, zusätzlich GitHub-Origin-Header live). Der vorhandene Cloudflare-Static-Assets-Worker `unfancy` ist kein belegtes Ziel dieser Domain und wird nicht verändert. Pages-Leserechte bei Cloudflare sind für diesen Release nicht erforderlich.
- Der neue Frontend-Stand ist zur unabhängigen Release-Abnahme vorbereitet; Veröffentlichung und Live-Abnahme stehen noch aus. Ziel: alle fünf kanonischen Routen und Sitemap live, korrekte Icons und Service Worker; keine behauptete Ranking-/CWV-Wirkung.
- `_headers` wird von GitHub Pages **nicht** ausgewertet. CSP-Report-Only und weitere Edge-Header bleiben ein separater offener Cloudflare-Schritt; vorhandenes HSTS `max-age=15552000` bleibt unverändert.
- Die aktiven API-Worker-Sources wurden am 24.11. lesend exportiert. Diese Source-Bundles allein beweisen **keinen** vollständigen Settings-/Binding-Restore. Der alte Write-Plan unten ist historischer Planungsstand, keine aktuelle Ausführungsfreigabe. Neue Worker-Uploads benötigen exact gepinnte Upload-/Rollback-Requests und frischen unabhängigen Review.
- Spotify-Refresh-Token wird weder rotiert noch ersetzt. Das bestehende Klartext-Binding wird nicht durch einen unvollständigen Upload stillschweigend gelöscht; eine gezielte Entfernung bleibt separat zu prüfen.

## Historischer Stand 22.11.2026 (nicht als aktueller Deploy-Nachweis verwenden)

Branch `kanban/t_52cfcf3b-local-fixes` (auf Basis des integrierten Standes `task/unfancy-integ-review`); vollständige Suite `node --test tests/*.test.mjs` grün, Browser-E2E (`scripts/e2e-browser.mjs`) grün, `git diff --check` sauber. **Nur lokal getestet — kein Merge, kein Produktion-Deploy.**

## Umgesetzt (Frontend)

- **Statische, crawlbare Routen** `/steam/`, `/spotify/`, `/lol/`, `/socials/` werden aus der Shell und den Fragmenten generiert (`node scripts/build-routes.mjs`); jede Seite mit eigenem Title, Description, Canonical, OG/Twitter und `data-static-page`-Marker. Query-Kompatibilität (`/?page=…`) bleibt erhalten; der Router löst zusätzlich Clean-Path-Deep-Links auf (`js/router.js`). `js/main.js` setzt jetzt seitenbezogene Titles statt des generischen Dashboard-Titels (im Browser verifiziert).
- **SEO-Grundlagen:** `sitemap.xml` mit genau den fünf kanonischen Routen; `robots.txt` verweist darauf; `404.html` ist `noindex,nofollow`.
- **Icons:** `favicon.png` (4,69 MB) entfernt; ersetzt durch quantisierte `favicon-64.png` (2,2 KB), `icon-192.png` (6,8 KB), `icon-512.png` (31 KB), `apple-touch-icon.png` (6,2 KB) – zusammen 46,5 KB. Manifest-Größen korrigiert. Generierung: `scripts/make-icons.py` (Pillow).
- **Steam/Chart-Lifecycle:** Chart.js **4.4.7 lokal** (`assets/vendor/chart.umd.js`), kein CDN mehr; Laden nur nach erfolgreichem Datenrender, 5-s-Timeout, Detached-Canvas- und Generation-Guard. Service Worker `unfancy-v7`: precached statische Routen/Icons/Chart-Bundle, persistiert **keine** API-Antworten mehr, API-Fetches mit `no-store`. Browser-E2E (`scripts/e2e-browser.mjs`) prüft zusätzlich den kontrollierten Direct-Load (`navigator.serviceWorker.controller`) einer statischen Route.
- **Worker-Härtung versioniert:** `workers/{spotify-auth,spotify-proxy,riot-proxy,steam-proxy}.js` mit negativen Tests (`tests/workers-hardening.test.mjs`): OAuth-Host-Allowlist + fester Callback (`spotify-auth`), **atomarer OAuth-State-Consume per Durable-Object-Transaktion** inkl. Parallel-/Replay-Tests, **fail-closed `/setup`** (`SETUP_TOKEN` ausschließlich als `Authorization: Bearer` im Header; ohne konfiguriertes Token 503, ohne/falsches Token 403), Methoden-/Pfad-/Input-Allowlists (inkl. exakter Pfad-Matches und Schema-Validierung der Steam-Player-Objekte: truthy-aber-leeres Player-Objekt → 502, kein leeres 200), CORS nur für erlaubte Origins (+`Vary: Origin`), Colo-lokales Best-Effort-Rate-Limit (30/60s pro IP+Pfadsegment, fail-open, keine Buckets für ungültige Routen), `no-store` auf Fehler-/429-Antworten. **Noch nicht deployed** – siehe unten. (Korrektur 22.11.2026: der frühere Verweis auf eine `/refresh-check`-Diagnostik beschrieb einen älteren Arbeitsstand; der konsolidierte Quellstand `3dcf4b82` enthält weder `/refresh-check` noch ein `DIAG_TOKEN`-Secret – siehe `docs/cloudflare-write-plan.md`, Korrektur unter W2.)
- **Chart.js lokal vendored:** `assets/vendor/chart.umd.js` (4.4.7) samt MIT-Lizenztexten (`LICENSE.chartjs.txt`, `LICENSE.kurkle-color.txt`); CDN-Quelle (`cdn.jsdelivr.net`) ist aus `js/views/steam.js` und der CSP-Report-Only entfernt.

## Cloudflare

- **W4 umgesetzt und live verifiziert:** Zone-Settings `security_header` auf HSTS `max-age=15552000`, `include_subdomains=false`, `preload=false`, `nosniff=false` (unverändert). Settings-Readback exakt Soll; Live-Header-Check auf `nirlau.de`, `www.nirlau.de` und `steam.api.nirlau.de` zeigt `max-age=15552000` ohne `includeSubDomains`/Preload. Rollback: `{max_age=0, include_subdomains=true, …}` (clientseitige Rollback-Grenze dokumentiert). `nosniff` bleibt ausdrücklich offener Punkt.
- **W0–W3, W5 offen (BLOCKIEREND im Review-Loop):** Der unabhängige Reviewer (GPT-6.2-sol) hat den Write-Plan für Worker-Deploys, Binding-Entfernung und Observability-Änderungen in sechs Runden nicht freigegeben; der aktuelle Plan (`docs/cloudflare-write-plan.md`) inkl. W0-Semantikprobe ist vorbereitet, aber nicht ausgeführt. Kein Worker-Write, kein Binding-Write, kein Observability-Write ist erfolgt.
- **Nicht möglich mit vorhandenem Token (Blocker):** CSP-Report-Only und weitere Edge-Header (Zone Transform Rules/Rulesets Write fehlt, Read-Probe 403), zonenweite Rate-Limiting-/Abuse-Regeln (403), Observability-Retention (separates Recht). **Kein Rechteausweitung, kein neuer Token.**
- **Refresh-Token unangetastet:** nicht gelesen, rotiert, widerrufen oder ersetzt. Nirlau rotiert/reautorisiert nach Abschluss selbst; das redundante `SPOTIFY_REFRESH_TOKEN`-Plain-Binding existiert live weiterhin (Entfernung = W2, offen).
- CSP-Report-Only ist **nicht** aktiv; die Meta-CSP ersetzt keine Edge-Header-Funktionen.

## Offene Punkte (konkret)

1. W0, W1, W2, W3, W5 gemäß `docs/cloudflare-write-plan.md` ausführen (benötigt GO des Reviewers; W0-Probe beweist Upload/PATCH/Rollback-Semantik empirisch). W4 (HSTS) ist bereits live und ausdrücklich **nicht** Gegenstand einer erneuten Ausführung.
2. Frontend-Deploy: Merge des getesteten Feature-Standes auf `main` (GitHub Pages) und Live-Wiederholung der Routen-/Sitemap-/Header-Checks. Kein Deploy wurde ausgeführt; der öffentliche Stand (`unfancy-v5`, 404 auf `/steam/` und `/sitemap.xml`) ist veraltet.
3. `nosniff` (zonenweit) und CSP-Report-Only: eigenes Review + Rechte (Zone Transform Rules/Rulesets Write).
4. Zonenweite Rate-Limiting-Regeln: Rechte fehlen.
5. Spotify-Refresh-Token-Rotation/Reautorisierung durch Nirlau nach Abschluss; danach KV als alleinige Quelle bestätigt lassen.

Keine CWV-/SEO-Wirkung behauptet – es liegen keine Feld-/Labormessungen vor; gemessen wurden nur funktionale Abnahmekriterien (Tests, HTTP- und Browser-Checks).
