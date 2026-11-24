# Recovery-Rollout Workers (Branch `recovery/unfancy-workers-20261124`)

Ziel: minimaler, reproduzierbarer Rollout-Pfad für `spotify-auth`, `spotify-proxy`,
`riot-proxy`, `steam-proxy` inkl. Rollback. **Production-Apply ist bewusst NICHT
Teil dieses Repos-Laufs** — dieser Branch liefert geprüfte Payloads, Readback-
Projektion und lokale Runtime-Smokes. Kein CF-Write ist automatisiert.

## Quell-Pin

Worker-Source: **Commit `6dcdd25`** (`workers/{spotify-auth,spotify-proxy,riot-proxy,steam-proxy}.js`,
73 Tests lokal grün). Jeder spätere Source-Commit erfordert Neuprüfung der
Payload-Metadaten; die erzeugten Payloads referenzieren den Pin über die
Annotation `workers/message`.

## Artefakte

- `recovery/build-payloads.mjs` — deterministischer Payload-Builder (kein Netz,
  kein CF-Aufruf). Neuerzeugung: `node recovery/build-payloads.mjs`.
- `recovery/generated/<worker>.deploy.json` — exakte PUT-Multipart-Spezifikation:
  - Query `bindings_inherit=strict` (fehlert mit API-Error **10057**, wenn ein
    `inherit`-Binding nicht auflösbar wäre, statt es still zu droppen).
  - Alle Live-Bindings als `{type:"inherit", name}` — **Werte verlassen Cloudflare
    nie**. Das schließt `SPOTIFY_REFRESH_TOKEN` (plain_text) ein: es wird nur
    namentlich geerbt, niemals gelesen/transportiert/zurückgeschrieben.
  - `spotify-auth` zusätzlich `{type:"durable_object_namespace", name:"OAUTH_STATE",
    class_name:"OAuthState"}` + top-level `migrations:
    [{"new_tag":"unfancy-oauthstate-2026-11-24","new_sqlite_classes":["OAuthState"]}]`.
    **Geprüft gegen die autoritative API-Doku (Stand 2026-11-24):** die
    Multipart-Metadata erlaubt `migrations` (DO-Migrations-Array) direkt beim
    sofort-deployenden Script-PUT; das Binding `durable_object_namespace` mit
    `class_name` erzeugt den Namespace über die Migration — **kein manuelles
    DO-Namespace-Create nötig**. `script_name` ist im Binding-Schema der
    Multipart-Doku nicht vorgesehen; dieselbe Klasse im selben Worker wird über
    `class_name` referenziert.
  - `compatibility_date`: `riot-proxy` `2025-10-01`, `steam-proxy` `2025-10-03`;
    beide Spotify-Worker: Feld **absent** (Ist-Zustand ist leer; Default wäre
    `2021-11-02` und veränderlich).
  - Parts: Moduldateien inkl. Imports (`invocation-logging.js` für
    spotify-/riot-/steam-proxy), Content-Type `application/javascript+module`.
- `recovery/generated/<worker>.rollback.json` — Rollback über die Versions-API:
  `POST /accounts/{account}/workers/scripts/{name}/deployments` mit
  `{strategy:"percentage", versions:[{version_id:<Pin>, percentage:100}]}`.
  Kein Statuspaket mit `null`-Feldern. **Pin ist historisch** (Discovery-Snapshot
  2026-11-24): vor Apply zwingend `GET .../deployments?per_page=1` — Deployment-ID
  und Version-ID müssen exakt dem Pin entsprechen, sonst Pin veraltet → Payloads
  aus frischem Read-only-Snapshot neu erzeugen, niemals blind anwenden. Zusätzlich
  `GET .../versions/{pin}` (200) vor Apply.
- `recovery/readback-projection.mjs` — sichere Settings-Projektion: nur
  Name/Typ/Ressource-ID (KV-Namespace-ID, class_name, …); wirft bewusst Fehler,
  wenn ein Binding ein Wertefeld (`text`/`value`) trägt — verhindert
  versehentliche Secret-Transporte aus Readbacks in Logs/Dateien. `spotify-proxy`
  Settings-GET bleibt im Operatorbetrieb trotzdem tabu (Binding-**Werte** werden
  auch projiziert nie gelesen).

## Lokale Runtime-Smokes (ohne Cloudflare-Konto, ohne echte Spotify-Tokens)

`node --test tests/oauthstate-miniflare.test.mjs` — echte workerd/SQLite-DO-Runtime
via Miniflare: paralleler Callback-Consume auf denselben State (genau ein
Token-Exchange, zwei 400), Replay 400, abgelaufener State 400, atomares
State-Create (409 bei Duplikat), fail-closed `/setup` (503 ohne `SETUP_TOKEN`,
403 bei falschem Bearer mit konfiguriertem Token, gefolgte Authorize-Weiterleitung
genau einmal gegen Mock). Sämtlicher Spotify-Verkehr ist gemockt
(miniflare `fetchMock` für den In-Worker-POST `/api/token`; undici globaler
Dispatcher-Mock für den Node-seitigen Redirect-Follow von `/setup`).
**Kein echter Spotify-Token-Austausch, kein Produktions-KV.**

Weitere Tests: `tests/recovery-payloads.test.mjs` (Payload-Struktur,
Wertefreiheit, Pins, Projektion) und die bestehende Suite (`node --test tests/`).

## Operator-Abfolge (nach Freigabe, pro Worker, Reihenfolge W1-artig)

1. Live-Readback je Worker: `GET .../deployments?per_page=1`,
   `GET .../versions/{pin}` und `GET .../settings` — Projektion über
   `readback-projection.mjs`; Abbruch bei Abweichung vom Discovery-Snapshot.
2. Deploy: Payload-JSON aus `recovery/generated/` als Multipart an den
   PUT-Endpoint (Bindings sind mit `inherit` wertfrei). **Niemals den spotify-proxy
   PUT ohne `bindings_inherit=strict`** — sonst könnte `SPOTIFY_REFRESH_TOKEN`
   still wegfallen; mit `strict` schlägt der Upload sicher fehl (10057).
3. Readback sofort danach (Projektion), Vergleich gegen
   `post_deploy_readback.expected_binding_names_sorted` und `expected_compat_date`;
   Abweichung → Stop + Rollback-Payload dieses Workers.
4. Funktionstest laut `docs/cloudflare-write-plan.md` (W1-Tests); für
   `spotify-auth` gilt die Sonderregel: Smoke erfolgt erst lokal (oben) und
   produktiv nur mit operator-seitigem autorisiertem `/setup`-Lauf.
   `/setup` bleibt ohne konfiguriertes `SETUP_TOKEN` bewusst **503 fail-closed** —
   bestehender Token wird so geschützt; Reautorisierung ist **nicht** Teil dieses
   Rollout-Pfads.
5. Fehlerfall: Rollback-Payload (Versions-Deployment) anwenden, Readback
   bestätigen, erst dann weiter.

## Echte Grenzen

- Rollback über die Versions-API setzt Code+Bindings der gepinnten Version zurück,
  beweist aber **keine** Wiederherstellbarkeit von Secret-**Werten**; die Vault-
  Ablage enthält keine Spotify-/Steam-/Riot-Secretwerte (Stand 22.11.2026).
  Secret-Verlust bleibt operator-only behebbar.
- `spotify-auth`-Rollback kehrt auf den KV-State-Consumer zurück und **verliert**
  Binding `OAUTH_STATE` + Klasse `OAuthState` (Atomizitätsgarantie weg). Ein
  Rückwechsel zum DO-Pfad erfordert eine neue Migration — nie löschen ohne
  separate geprüfte Entfernungs-Migration.
- Der DO-Migrations- und `OAUTH_STATE`-Payload ist an die autoritative API-Doku
  angelehnt, aber **nicht produktiv verifiziert**; der erste Apply muss step 1–3
  der Abbruchregeln erfüllen.
- Keine Token-Rotation/Revocation; kein Frontend-Deploy (Frontend ist GitHub Pages,
  SHA `57cd802`, bleibt unangetastet); HSTS (W4) unverändert.
- Keine CF-Reads/-Writes durch Agenten in diesem Lauf; alle CF-Aufrufe oben sind
  Operator-Schritte.
