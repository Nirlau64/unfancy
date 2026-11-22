# Cloudflare-Write-Plan Unfancy (Stand 22.11.2026, nach Live-Readback)

Live-Readback (read-only, 22.11.2026):
- Zone `nirlau.de` security_header: HSTS `enabled=true, max_age=0, include_subdomains=true, preload=false, nosniff=false` (kein wirksames HSTS).
- Worker-Deployments (production, aktiv): `spotify-auth` (Host `spotify-auth.nirlau.de`), `spotify-proxy` (`spotify.api.nirlau.de`), `riot-proxy` (`api.nirlau.de`), `steam-proxy` (`steam.api.nirlau.de`).
- Bindings (Namen/Typen): spotify-auth: `SPOTIFY_CLIENT_ID`(secret), `SPOTIFY_CLIENT_SECRET`(secret), `TOKENS`(KV 25d14d1f2e2f401fb48facad0d108d66). spotify-proxy: `SPOTIFY_CLIENT_ID`(plain), `SPOTIFY_CLIENT_SECRET`(secret), **`SPOTIFY_REFRESH_TOKEN`(plain_text, redundant – Worker liest Token ausschließlich aus KV `TOKENS`, im Quelltext verifiziert)**, `TOKENS`(KV, dieselbe Namespace-ID). riot-proxy: `RIOT_API_KEY`(secret). steam-proxy: `STEAM_API_KEY`(secret).
- Observability riot-/steam-proxy: enabled, sampling 1, `redact_query_string=false`, invocation_logs persist=true.
- Token-Probes: Zone rate_limits/rulesets Read → 403 (kein Recht); Worker Scripts Read/Write vorhanden; Zone Settings Read/Write vorhanden (verify_unfancy_token.py: alle 200).

## Geplante Writes (Reihenfolge, exakte Payloads, Rollback)

### W1 — Worker-Source-Deploys (jeweils PUT `/accounts/{account}/workers/scripts/{name}`, multipart, Bindings unverändert lassen)
Neue Sources: `workers/{spotify-auth,spotify-proxy,riot-proxy,steam-proxy}.js` im Branch `task/high-impact-unfancy` (Commits bis auf weiteres (siehe git log), lokal getestet, 45/45).
Änderungen vs. Live (Diff-Focus):
- spotify-auth: feste `ALLOWED_ORIGINS=['https://spotify-auth.nirlau.de']`, feste `redirect_uri`, 403 bei fremdem Host für /setup//callback; State-Consume unverändert (bereits einmalig, delete vor Token-Austausch).
- spotify-proxy: GET/OPTIONS only (sonst 405), `range`-Allowlist (400 bei ungültig), ACAO nur bei allowlisteter Origin (sonst weggelassen), Rate-Limit 30/60s pro IP+Pfad via Cache-API (429), 404 unverändert.
- riot-proxy: GET/OPTIONS only, Name/Tag/Region-Validierung (400 ohne Upstream-Call), ACAO nur allowlisted, Rate-Limit 30/60s (429).
- steam-proxy: SteamID64-Validierung `/^\d{17}$/` (400 ohne Upstream-Call), GET/OPTIONS only, ACAO nur allowlisted, Rate-Limit 30/60s (429), `detail` aus 502 entfernt.
Payload-Struktur: zweiteiliges Multipart-Form mit `metadata`-Part `{"main_module":"worker.js","compatibility_date":"2025-10-01"}` **ohne `bindings`-Schlüssel** – Cloudflare erhält bestehende Bindings und Secret-Werte unverändert, wenn keine Bindings im Metadata übergeben werden; es wird also keinerlei Bindings-Liste gesendet (W1 fasst Bindings strukturell nicht an). `compatibility_date` exakt wie Live-Readback 2025-10-01.
Abbruchregel: nach jedem Deploy Readback (Script-Content-Hash, Settings-Readback Bindings-Namen/Typen) – weicht ein Binding-Name/Typ vom Ist ab: sofort Stop und Rollback.
Rollback: Live-Quellen liegen unverändert unter `~/.hermes/cache/scratch/cf-live/{name}.js` (multipart-wrapped); Re-Deploy dieser Inhalte mit gleichem Metadata-Schema (ohne bindings) stellt Source und compatibility_date wieder her; Bindings bleiben davon unberührt (sie wurden ja auch nicht verändert). Etag/Versionen im Readback dokumentiert. Bindings/Settings-Rollback ist für W1 nicht nötig, weil W1 sie nicht verändert.
Reihenfolge/Tests: pro Worker Deploy → sofortiger Funktionstest (spotify-proxy: `/now-playing` (echter Request), `/top-tracks?range=short_term`, 405-Test, CORS-Negativtest; steam-proxy: `/profile?steamid=<echte ID>` (gültiger Test-steamid), `/profile?steamid=abc` → 400; riot-proxy: echter Frontend-Aufruf `/lol/Nirlau/Lauri/euw`, ungültige ID → 400; spotify-auth: `/health`, `/setup` mit falschem Host → 403 (Host-Header-Test)). Bei Fehler: Stop, kein weiterer Write, Rollback des betroffenen Workers.

### W2 — spotify-proxy Settings: redundantes Klartext-Binding entfernen
PATCH `/accounts/{account}/workers/scripts/spotify-proxy/settings` mit Body `{"bindings":[{"type":"plain_text","name":"SPOTIFY_CLIENT_ID","text":"<IST-WERT, nicht-geheim, vorher aus Readback übernommen und im Call verwendet, nie protokolliert>"},{"type":"secret_text","name":"SPOTIFY_CLIENT_SECRET"},{"type":"kv_namespace","name":"TOKENS","namespace_id":"25d14d1f2e2f401fb48facad0d108d66"}]}` – d. h. die vollständige Ist-Bindings-Liste **minus** `SPOTIFY_REFRESH_TOKEN`; secret_text wird nur namentlich referenziert (kein Wert im Payload), KV-Namespace-ID exakt wie Ist.
Dynamischer KV-Nachweis vor W2: nach W1 `/now-playing` testen – ein 200 mit gültigem JSON beweist den KV-Leseweg dynamisch, weil der Access-Token-Austausch den Refresh-Token aus KV liest (der Token-Cache in `caches.default` ist colo-lokal; bei kaltem Cola läuft der Austausch real durch). Falls `/now-playing` fehlschlägt: W2 wird nicht ausgeführt.
Abbruchregel: Readback der Settings direkt nach PATCH – es darf genau die Dreier-Liste oben übrig bleiben; jede Abweichung (fehlendes/verändertes Binding) → Stop, Befund dokumentieren. `SPOTIFY_REFRESH_TOKEN` darf im Readback nicht mehr erscheinen.
Rollback: bewusst nicht vorgesehen (Refresh-Token-Wert wird zu keinem Zeitpunkt gelesen/kopiert); stattdessen enthält der Plan die dynamische Beweisführung vor dem Write und den Abbruch-Readback danach. Falls Nirlau später doch ein Binding zurückwill: Neuanlage als secret_text mit einem frisch rotierten Token (Nirlau rotiert nach Abschluss ohnehin).
Known Limitation (dokumentiert): KV-`get`+`delete` für den OAuth-State ist nicht atomar/transactionslos; ein exakt gleichzeitiger Replay im selben Millisekunden-Fenster auf demselben KV-Edge ist theoretisch möglich und wird durch den Delete-Sofort-Aufruf minimiert, nicht formal ausgeschlossen.
Keine Rotation/Revokation des bestehenden Refresh-Tokens (Nirlau rotiert nach Abschluss selbst).

### W3 — Observability riot-/steam-proxy
PUT `/accounts/{account}/workers/scripts/{name}/settings`: `observability = {enabled:true, head_sampling_rate:0.2, redact_query_string:true, logs:{enabled:true, head_sampling_rate:0.2, persist:true, invocation_logs:true}, traces:{enabled:false, head_sampling_rate:1, persist:true}}` (nur Änderungen: Query-Redaction an, Sampling 1→0.2; Persistenz bleibt an).
Rollback: exakte Ist-Werte oben (sampling 1, redact_query_string false).
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
