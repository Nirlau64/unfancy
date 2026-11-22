# Cloudflare-Write-Plan Unfancy (Stand 22.11.2026, nach Live-Readback)

Live-Readback (read-only, 22.11.2026):
- Zone `nirlau.de` security_header: HSTS `enabled=true, max_age=0, include_subdomains=true, preload=false, nosniff=false` (kein wirksames HSTS).
- Worker-Deployments (production, aktiv): `spotify-auth` (Host `spotify-auth.nirlau.de`), `spotify-proxy` (`spotify.api.nirlau.de`), `riot-proxy` (`api.nirlau.de`), `steam-proxy` (`steam.api.nirlau.de`).
- Bindings (Namen/Typen): spotify-auth: `SPOTIFY_CLIENT_ID`(secret), `SPOTIFY_CLIENT_SECRET`(secret), `TOKENS`(KV 25d14d1f2e2f401fb48facad0d108d66). spotify-proxy: `SPOTIFY_CLIENT_ID`(plain), `SPOTIFY_CLIENT_SECRET`(secret), **`SPOTIFY_REFRESH_TOKEN`(plain_text, redundant – Worker liest Token ausschließlich aus KV `TOKENS`, im Quelltext verifiziert)**, `TOKENS`(KV, dieselbe Namespace-ID). riot-proxy: `RIOT_API_KEY`(secret). steam-proxy: `STEAM_API_KEY`(secret).
- Observability riot-/steam-proxy: enabled, sampling 1, `redact_query_string=false`, invocation_logs persist=true.
- Token-Probes: Zone rate_limits/rulesets Read → 403 (kein Recht); Worker Scripts Read/Write vorhanden; Zone Settings Read/Write vorhanden (verify_unfancy_token.py: alle 200).

## Geplante Writes (Reihenfolge, exakte Payloads, Rollback)

### W0 — Semantik-Probe (beweist den Upload-/Erhaltungsvertrag, bevor ein echter Worker angefasst wird)
Create `unfancy-harden-probe` (PUT script) mit Metadata `{main_module:"worker.js", compatibility_date:"2025-10-01", bindings:[{type:"plain_text",name:"PROBE_PLAIN",text:"probe-value"},{type:"secret_text",name:"PROBE_SECRET",text:"<zufälliger Testwert, nur im Speicher, nie protokolliert>"}]}`; dann zweiter PUT desselben Scripts mit Metadata `{main_module:"worker.js", compatibility_date:"2025-10-01", bindings:[{type:"secret_text",name:"PROBE_SECRET"}]}` (secret nur namentlich referenziert, plain weggelassen). Readback der Settings nach jedem PUT.
Beweisziel: (a) secret_text ohne `text` behält den bestehenden Secretwert (kein Binding-Verlust durch Name-Only), (b) Bindings-Verhalten bei Weglassen/Explizitsetzen ist dokumentiert, (c) Rollback per Re-Upload funktioniert. Danach DELETE `/workers/scripts/unfancy-harden-probe` und Readback 404 als Aufräumbestätigung. Entfernt die Annahme-Lücke aus Review-Runde 2 (Finding 1). Falls die Semantik abweicht (Secret geht verloren, Bindings werden gedroppt): W1/W2 werden nicht ausgeführt und der Befund dokumentiert.

### W1 — Worker-Source-Deploys (jeweils PUT `/accounts/{account}/workers/scripts/{name}`, multipart, Bindings explizit aus Live-Readback)
Neue Sources: `workers/{spotify-auth,spotify-proxy,riot-proxy,steam-proxy}.js` im Branch `task/high-impact-unfancy` (Commits bis auf weiteres (siehe git log), lokal getestet, 47/47).
Änderungen vs. Live (Diff-Focus):
- spotify-auth: feste `ALLOWED_ORIGINS=['https://spotify-auth.nirlau.de']`, feste `redirect_uri`, 403 bei fremdem Host für /setup//callback; State-Consume unverändert (bereits einmalig, delete vor Token-Austausch).
- spotify-proxy: GET/OPTIONS only (sonst 405), `range`-Allowlist (400 bei ungültig), ACAO nur bei allowlisteter Origin (sonst weggelassen), Rate-Limit 30/60s pro IP+Pfad via Cache-API (429), 404 unverändert.
- riot-proxy: GET/OPTIONS only, Name/Tag/Region-Validierung (400 ohne Upstream-Call), ACAO nur allowlisted, Rate-Limit 30/60s (429).
- steam-proxy: SteamID64-Validierung `/^\d{17}$/` (400 ohne Upstream-Call), GET/OPTIONS only, ACAO nur allowlisted, Rate-Limit 30/60s (429), `detail` aus 502 entfernt.
Payload-Struktur: zweiteiliges Multipart-Form mit `metadata`-Part. Die **bindings werden explizit gesetzt** – zur Laufzeit aus dem Live-Settings-Readback konstruiert (secret_text nur Name, kein Wert; kv_namespace mit Namespace-ID; plain_text mit Ist-`text`, im Speicher gehalten, nie protokolliert). `compatibility_date` pro Worker exakt wie Ist (`riot-proxy`: `2025-10-01`, `steam-proxy`: `2025-10-03`, beide Spotify-Worker: Feld leer → Feld im Metadata **weglassen**). Quelle: `cf-live/settings-and-versions.json`.
Abbruchregel: nach jedem Deploy Readback der Script-Settings inklusive KV-Namespace-IDs und compatibility_date; jede Abweichung (Name, Typ, KV-ID, compatibility_date) vom Ist → sofort Stop und Rollback des Workers.
Rollback: Versionen-API enthält keine Einträge (geprüft), daher Re-Upload der Live-Quelle. Die gesicherten Live-Quellen liegen unter `~/.hermes/cache/scratch/cf-live/{name}.js` als Multipart-Antwort; der Rollback-Script extrahiert `worker.js` (Body zwischen den Boundary-Markern) und PUT-et sie mit dem **exakt gesicherten Ist-Metadata** (compatibility_date laut Readback, Bindings-Liste laut Readback; Secretwerte nie in Dateien – secret_text namentlich). Das stellt Source, compatibility_date und Bindings-Namen/Typen/KV-IDs wieder her; Secretwerte bleiben von Cloudflare gehalten. Etag im Readback dokumentiert.
Reihenfolge/Tests: pro Worker Deploy → sofortiger Funktionstest (spotify-proxy: `/now-playing` (echter Request), `/top-tracks?range=short_term`, 405-Test, CORS-Negativtest; steam-proxy: `/profile?steamid=<echte ID>` (gültiger Test-steamid), `/profile?steamid=abc` → 400; riot-proxy: echter Frontend-Aufruf `/lol/Nirlau/Lauri/euw`, ungültige ID → 400; spotify-auth: `/health`, `/setup` mit falschem Host → 403 (Host-Header-Test)). Bei Fehler: Stop, kein weiterer Write, Rollback des betroffenen Workers.

### W2 — spotify-proxy Settings: redundantes Klartext-Binding entfernen
PATCH `/accounts/{account}/workers/scripts/spotify-proxy/settings` mit Body `{"bindings":[{"type":"plain_text","name":"SPOTIFY_CLIENT_ID","text":"<IST-WERT, nicht-geheim, vorher aus Readback übernommen und im Call verwendet, nie protokolliert>"},{"type":"secret_text","name":"SPOTIFY_CLIENT_SECRET"},{"type":"kv_namespace","name":"TOKENS","namespace_id":"25d14d1f2e2f401fb48facad0d108d66"}]}` – d. h. die vollständige Ist-Bindings-Liste **minus** `SPOTIFY_REFRESH_TOKEN`; secret_text wird nur namentlich referenziert (kein Wert im Payload), KV-Namespace-ID exakt wie Ist.
Dynamischer KV-Nachweis vor W2: die neue spotify-proxy-Quelle verwendet einen **versionsisierten Token-Cache-Key** (`access_token/v2`), sodass der erste Request nach dem Deploy garantiert keinen Access-Token-Cache-Treffer hat und den Refresh-Token-Austausch über KV real durchführt. Ein 200 mit gültigem JSON auf `/top-tracks?range=short_term` und anschließend `/now-playing` beweist damit beobachtbar den KV-Leseweg (kein Tokenwert wird gelesen/logged). Falls diese Requests fehlschlagen: W2 wird nicht ausgeführt.
Abbruchregel: Readback der Settings direkt nach PATCH – es darf genau die Dreier-Liste oben übrig bleiben; jede Abweichung (fehlendes/verändertes Binding) → Stop, Befund dokumentieren. `SPOTIFY_REFRESH_TOKEN` darf im Readback nicht mehr erscheinen.
Recovery für versehentlich verlorene Keep-Bindings (getrennt von der beabsichtigten Löschung): Re-Add über denselben Settings-PATCH; `SPOTIFY_CLIENT_ID` (plain_text, nicht-geheim) liegt im Speicher des Ausführungsscripts vor; `SPOTIFY_CLIENT_SECRET` ist in der Secret-Ablage (`Hermes-Secrets`) verfügbar und würde von Nirlau über den Vault wiederhergestellt werden – kein automatischer Export von Secretwerten. Falls Nirlau das Refresh-Token-Binding später doch zurückwill: Neuanlage als secret_text mit einem frisch rotierten Token.
Request-Vertrag: W2 wird erst nach W0 ausgeführt; der W0-Probe beweist empirisch, wie die API secret_text-name-only und plain_text behandelt; der W2-Call nutzt exakt dieselbe, dann belegte Form (PATCH `/workers/scripts/{name}/settings`, JSON-Body `{"bindings":[...]}`). Readback-Abbruchregel wie oben.
Known Limitation (dokumentiert): KV-`get`+`delete` für den OAuth-State ist nicht atomar/transactionslos; ein exakt gleichzeitiger Replay im selben Millisekunden-Fenster auf demselben KV-Edge ist theoretisch möglich und wird durch den Delete-Sofort-Aufruf minimiert, nicht formal ausgeschlossen.
Keine Rotation/Revokation des bestehenden Refresh-Tokens (Nirlau rotiert nach Abschluss selbst).

### W3 — Observability riot-/steam-proxy
PUT `/accounts/{account}/workers/scripts/{name}/settings`: `observability = {enabled:true, head_sampling_rate:0.2, redact_query_string:true, logs:{enabled:true, head_sampling_rate:0.2, persist:true, invocation_logs:true}, traces:{enabled:false, head_sampling_rate:1, persist:true}}` (nur Änderungen: Query-Redaction an, Sampling 1→0.2; Persistenz bleibt an).
Rollback: vollständiges Ist-Objekt je Worker (aus `cf-live/settings-and-versions.json`): `{"enabled":true,"head_sampling_rate":1,"redact_query_string":false,"logs":{"enabled":true,"head_sampling_rate":1,"persist":true,"invocation_logs":true},"traces":{"enabled":false,"head_sampling_rate":1,"persist":true}}`.
Einordnung: der Worker-Level-Rate-Limiter ist ein Colo-lokales Best-Effort-Limit (Cache-API, nicht atomar, ohne globale Konsistenz); gegen gezielten multi-colo-Missbrauch sind zonenweite Cloudflare-Rate-Limiting-Regeln nötig (Blocker unten, fehlende Permission).
Falls 403 (fehlendes Recht): Abbruch dieses Schritts, Blocker dokumentieren, keine Umgehung.

### W4 — Zone security_header (nur HSTS)
PATCH `/zones/{zone}/settings/security_header`:
`{"value":{"strict_transport_security":{"enabled":true,"max_age":15552000,"include_subdomains":false,"preload":false,"nosniff":false}}}`
Begründung: max-age 180 Tage, ausdrücklich ohne `includeSubDomains` (Wiki-Tunnel/Subdomains nicht voll HTTPS-inventarisiert) und ohne Preload. `nosniff` bleibt auf Ist-Wert `false` – die zonenweite `X-Content-Type-Options`-Aktivierung ist eine separate Änderung ohne eigene Freigabe in diesem Durchlauf und wird als offener Punkt dokumentiert.
Rollback: exakter Ist-Stand `{enabled:true,max_age:0,include_subdomains:true,preload:false,nosniff:false}`.
Verifikation: Settings-Readback **und** Live-Header-Check `curl -sI https://nirlau.de/ | grep -i strict-transport-security` muss `max-age=15552000` ohne `includeSubDomains` zeigen; bei Abweichung zwischen Settings-Readback und Live-Header: Stop und Befund.

### Nicht durchführbar mit vorhandenem Token (Blocker, keine Umgehung)
- CSP-Report-Only und weitere Edge-Header (Referrer-Policy, Permissions-Policy, frame-ancestors): benötigt Zone Transform Rules / Rulesets Write oder Workers-Routes-Write — Probe Read endete 403. Alternative (Zusatz-Worker-Route auf nirlau.de) würde Routing der Live-Site anfassen → ohne Freigabe nicht getan.
- Cloudflare Rate-Limiting-Regeln/Abuse-Regeln auf Zonenebene: Zone rate_limits/rulesets Read → 403; stattdessen Worker-Level-Limits (W1). Zonenebene bleibt Blocker mit fehlender Permission.
- Observability-Retention (accountweit): separates Recht, nicht geprüft/beantragt; bleibt offen.
- WAF-/Bot-Regeln, DNS, Access: nicht Bestandteil dieses Plans.
