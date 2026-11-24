# Recovery-Rollout Workers (Branch `recovery/unfancy-workers-20261124`)

Ziel: reproduzierbare Rollout-Artefakte mit getrenntem Scope je Worker. Der
reviewte Steam-Versuch wurde nach fehlgeschlagenem Live-Smoke zurückgerollt;
Riot wurde nicht ausgerollt. **Weitere Apply-Aufrufe sind eingefroren**, bis
Smoke-Ursache und ein phasenkorrekter Resume-Pfad separat geprüft sind.
Die lokalen Testbefehle verwenden keinen Cloudflare-Zugang.

## Scopes (ehrlich getrennt)

| Worker | Apply-Approval | Rollback | Warum |
| --- | --- | --- | --- |
| `steam-proxy` | reviewter Live-Versuch **zurückgerollt**, weiterer Apply eingefroren | Altversion + Settings + Smoke verifiziert | neuer Live-Smoke scheiterte |
| `riot-proxy` | **nicht ausgeführt**, Kette gestoppt | receipt-gestützt vorbereitet | kein verifizierter Steam-Erfolg |
| `spotify-proxy` | `GATED_READ_SCOPE` | supported, aber ohne Settings-GET | verbotene Reads |
| `spotify-auth` | `NOT_YET_APPROVED` | **KEIN** supported Rollback | DO-Klassen-Lebenszyklus |

Der historische PUT-Runner (`recovery/runner.mjs`) ist **eingefroren und NOT
APPROVED** (CLI failt closed); für steam/riot gilt nur der Weg über
`recovery/staged-runner.mjs` nach Parent-Review.

- **spotify-proxy, verbotene Reads:** `GET .../settings` und `GET .../versions/{id}`
  sind für diesen Worker tabu — die Settings-Antwort kann das plain_text-Binding
  `SPOTIFY_REFRESH_TOKEN` enthalten. Verboten auch im Fehlerpfad. Der Runner-Endpoint-
  Allowlist fehlen beide Muster strukturell (auch für einen Apply-Versuch: der Runner
  lehnt `spotify-proxy` als `GATED_READ_SCOPE` ab).
- **Historie ehrlich:** ein früheres Discovery-Script HAT ein Settings-GET des
  `spotify-proxy` durchgeführt und die Ausgabe **danach** redigiert. Die korrekte
  Aussage ist „Output wurde nach dem Empfang redigiert" — **nicht** „nie etwas
  empfangen". Es gibt keinen Wiederholungsbedarf und keine Wiederholung.
- **Binding-Drift auf spotify-proxy ist ohne verbotene Reads nicht verifizierbar**
  (`binding_drift_safety_note` im Payload). `bindings_inherit=strict` (API-Error 10057)
  fängt veränderte inherit-auflösbare Bindings; ein unerwartet ZUSÄTZLICHES Live-Binding
  wird von strict nicht abgedeckt und würde durch die explizite Bindings-Liste ersetzt —
  nur nach separater geprüfter Entscheidung anwenden.
- **spotify-auth:** Die `OAuthState`-Migration wird durch diesen Upload ERZEUGT. Ein
  Versions-Rollback auf die pre-DO-Altversion rückt den Migrations-/Klassenzustand
  **nicht** zurück (DO-Klassen-Lebenszyklus blockiert sauberes Rollback). Payload und
  Runtime sind geprüft; **keine Aussage über „supported rollback"**. Apply/Rollback sind
  aus dem ausführbaren Runner-Scope entfernt, bis eine separat geprüfte Rollback-Geschichte
  existiert. Auth-Payload bleibt als Vorlage (`rollback_supported:false`).

## Quell-Pin

Worker-Source: **Commit `6dcdd25`** (`workers/{spotify-auth,spotify-proxy,riot-proxy,steam-proxy}.js`).
Jeder spätere Source-Commit erfordert Neuprüfung der Payload-Metadaten; die erzeugten
Payloads referenzieren den Pin über die Annotation `workers/message`.

## Artefakte

- `recovery/build-payloads.mjs` — deterministischer Payload-Builder (kein Netz,
  kein CF-Aufruf). Repo-Neuerzeugung: `node recovery/build-payloads.mjs` (schreibt
  ausschließlich `recovery/generated/` + `SHA256SUMS.txt`). Programmatic API:
  `buildPayloads({ outDir })` — schreibt **nie** ins Repo; Byte-Drift muss der
  Aufrufer per Bytevergleich feststellen (siehe Test), Drift **failt**, wird nie
  still überschrieben.
- `recovery/generated/<worker>.deploy.json` — exakte Upload-Pin-Quelle (die
  historische PUT-Spezifikation des gefrorenen Runners; der staged-runner nutzt
  sie AUSSCHLIESSLICH als Pin-Quelle und baut die Upload-Metadaten als strikte
  Teilmenge: nur `main_module`, `compatibility_date`, `compatibility_flags`,
  `bindings type:'inherit'`):
  - Query `bindings_inherit=strict` (fehlert mit API-Error **10057**, wenn ein
    `inherit`-Binding nicht auflösbar wäre, statt es still zu droppen).
  - Alle Live-Bindings als `{type:"inherit", name}` — **Werte verlassen Cloudflare
    nie**. Das schließt `SPOTIFY_REFRESH_TOKEN` (plain_text) ein: es wird nur
    namentlich geerbt, niemals gelesen/transportiert/zurückgeschrieben.
  - `spotify-auth` zusätzlich `{type:"durable_object_namespace", name:"OAUTH_STATE",
    class_name:"OAuthState"}` + **`migrations` als OBJEKT** (nicht Array!), geprüft
    gegen das offizielle GitHub-Schema `cloudflare/api-schemas`
    (`workers_multiple_step_migrations`: Tag-Conditions + `steps`-Array):
    `"migrations":{"new_tag":"unfancy-oauthstate-2026-11-24","steps":[{"new_sqlite_classes":["OAuthState"]}]}`.
    Das Binding `durable_object_namespace` mit `class_name` erzeugt den Namespace
    über die Migration — kein manuelles DO-Namespace-Create nötig. **Der frühere
    Migration-Tag ist explizit ABSENT gepinnt** (`live_migration_tag_before.state:"absent"`,
    Beleg: Settings-Readback im Discovery-Snapshot enthält keine Migrations-Felder);
    keine Annahmen über einen Vorgänger-Tag.
  - `compatibility_date`: `riot-proxy` `2025-10-01`, `steam-proxy` `2025-10-03`;
    beide Spotify-Worker **explizit `2021-11-02`** — das dokumentierte effektive
    Default (cloudflare/cloudflare-docs, multipart-upload-metadata: „it defaults to
    the oldest compatibility date before any flags took effect (2021-11-02)"),
    das dem Live-Ist (leeres Feld) entspricht. Nicht „absent" erwartet, sondern als
    effektives Datum gepinnt; der Miniflare-Smoke nutzt exakt dasselbe Datum.
  - **Vollständige Safe-Settings-Erhaltung** (aus dem redigierten Snapshot, exakt):
    `compatibility_flags`, `tags`, `logpush`, `tail_consumers`, `placement`,
    `usage_model`, und für riot/steam das komplette `observability`-Objekt inkl.
    `logs`/`traces`. Jedes Feld hat eine explizite Klassifikation
    (`preserve`/`absent`/`n.a.`); **unbekannte Live-Fields → Abbruch**, keine Defaults.
  - Parts: Moduldateien inkl. Imports (`invocation-logging.js` für
    spotify-/riot-/steam-proxy), Content-Type `application/javascript+module`.
  - **Byte-Pins:** `metadata_sha256` (exaktes Multipart-Metadata-JSON) und
    `part_sha256` (exakte Modul-Bytes) sind im Payload gepinnt; der Runner berechnet
    vor dem Senden nach und bricht bei jeder Abweichung VOR dem Upload ab.
  - **Pre-Apply-Drift-Guards** (getrennt von den Post-Write-Guards):
    1. aktives Deployment === gepinnte Deployment-ID **und** gepinnte Version-ID;
    2. neueste Upload-Version === gepinnte aktive Version (`inherit` löst gegen die
       **LATEST UPLOADED**, nicht die aktive Version auf); vor dem Upload gilt
       latest===alter Pin, danach latest===eigene UUID. Es gibt keinen separaten
       Versions-Zähler-Guard; eine fremde neueste Version führt zu STOP;
    3. vollständige Safe-Settings inkl. Bindings-Inventar (riot/steam: erlaubtes
       Settings-GET, da nur `secret_text`-Bindings; spotify-proxy: **entfällt**,
       siehe verbotene Reads).
  - Pre-Rollback-Guards sind getrennt: sie prüfen den Laufzeitstatus NACH dem Apply.
- `recovery/generated/<worker>.rollback.json` — Rollback über die Versions-API:
  `POST /accounts/{account}/workers/scripts/{name}/deployments` mit
  `{strategy:"percentage", versions:[{version_id:<Pin>, percentage:100}]}`.
  Kein Statuspaket mit `null`-Feldern. **Pin ist historisch** (Discovery-Snapshot
  2026-11-24). Der Pre-Rollback-Guard läuft gegen die **NEU ERZEUGTE EIGENE Version**
  (Runtime-Zustand aus der Versions-Upload-Antwort `result.id` — UUID —, kein
  hartkodierter Pin):
  - fremde Version aktiv → STOP (fremdes zwischengeschaltetes Deployment);
  - alter Pin noch aktiv → Rollback **SKIPP** (die eigene Version ist nur STAGED —
    es gab keine Aktivierung, ein Rollback ist nicht nötig);
  - eigene neue Version aktiv → Rollback freigegeben; vorher geprüft, dass die alte
    Version noch in der Versions-LISTE existiert (`GET .../versions`, erster Eintrag
    ist der neueste — außer spotify-proxy, wo jeder Versions-Read verboten ist; dort
    bleibt nur der Deployments-Guard).
  - **Upload/Activation gescheitert/unverändert → kein Rollback.** Unklarer
    Write-Ausgang (Transportfehler ODER HTTP/API-Ablehnung — behandelt identisch) →
    genau ein Klassifikations-Readback: nach Upload die Versionsliste, nach
    Aktivierung/Rollback die Deployments. Bestätigte Aktivität erfordert danach
    die jeweiligen weiteren Verifikationsreads und Smokes. Weiterhin unklar →
    STOP „unverified", **kein Wiederholen**, kein blindes Re-Write.
- `recovery/generated/SHA256SUMS.txt` — Byte-Pins der 8 vollständigen JSON-Dateien
  (Test geprüft gegen die tatsächlichen Dateien).
- `recovery/readback-projection.mjs` — sichere Settings-Projektion: Bindings nur
  Name/Typ/Ressource-ID; Safe-Settings-Felder (komplettes `observability`, etc.)
  werden **vollständig** projiziert (wertfrei). Wirft bewusst Fehler, wenn ein
  Binding ein Wertefeld (`text`/`value`) trägt — verhindert versehentliche Secret-
  Transporte aus Readbacks in Logs/Dateien.
- `recovery/runner.mjs` — **EINGEFROREN (NOT APPROVED)**: der historische
  PUT-Runner. Die CLI verweigert `--execute` (fail closed). Begründung: die
  PUT-Response-`id` war der Scriptname (kein Versions-UUID) und der neue
  Vertrag läuft über die Versions-API (`recovery/staged-runner.mjs`). Die
  orchestrierten Tests (`tests/runner-orchestrator.test.mjs`) bleiben als
  Regressionsschutz — sie beanspruchen **keine** ausführbare Freigabe.
- `recovery/staged-runner.mjs` — ausführbarer Staged-Runner (Node ESM, **injected
  transport**, kein Netz im Modul): `POST versions?bindings_inherit=strict`
  (staged/inaktiv, `result.id` UUID), wertfreies Receipt vor der Aktivierung
  (`recovery/runs/`, gitignored), `POST deployments
  {strategy:'percentage',versions:[{version_id:<own UUID>,percentage:100}],force:false}`.
  - Bearer **ausschließlich** aus `process.env.CF_API_TOKEN` (CLI-Pfad); kein op-/
    1Password-ENV wird gelesen oder weitergegeben (Resolver ist Sache des Parents).
  - Endpoint-Allowlist ausschließlich aus den Payloads; jede URL wird vor I/O geprüft,
    auch im Fehlerpfad. Verbotene Reads sind strukturell unmöglich.
  - Multiplart-Bytes: Metadata-JSON und Parts werden per SHA-256-Pin geprüft, **rohe
    Bodies werden nie geloggt** (nur Methode/URL/Status/Klassifikationen).
  - Sequentieller Flow (staged-runner): Guards (aktiv===alter Pin, LATEST===alter
    Pin, volle Safe-Settings) → `POST versions?bindings_inherit=strict` (staged,
    eine Wiederholung niemals) → Receipt → Aktivierungs-Guards (aktiv UNVERÄNDERT
    auf dem alten Pin, LATEST === eigene UUID, Settings unverändert) → `POST
    deployments {percentage:100, force:false}` → postActivationVerify (eigenes
    Deployment readback; Settings-Readback) → bei Verifikations-/Smoke-Fehler
    gemeinsamer guarded Rollback (auto + standalone ein Pfad).

## Lokale Runtime-Smokes (ohne Cloudflare-Konto, ohne echte Spotify-Tokens)

`node --test tests/oauthstate-miniflare.test.mjs` — echte workerd/SQLite-DO-Runtime
via Miniflare, **`compatibilityDate: '2021-11-02'`** (exakt der im Payload gepinnten
effektiven Datum, date-consistent): paralleler Callback-Consume auf denselben State
(genau ein Token-Exchange, zwei 400), Replay 400, abgelaufener State 400, atomares
State-Create (409 bei Duplikat), fail-closed `/setup` (503 ohne `SETUP_TOKEN`,
403 bei falschem Bearer mit konfiguriertem Token, gefolgte Authorize-Weiterleitung
genau einmal gegen Mock). Sämtlicher Spotify-Verkehr ist gemockt
(miniflare `fetchMock` für den In-Worker-POST `/api/token`; undici globaler
Dispatcher-Mock für den Node-seitigen Redirect-Follow von `/setup`).
**Kein echter Spotify-Token-Austausch, kein Produktions-KV.**

Weitere Tests:
- `tests/recovery-payloads.test.mjs` — Payload-Struktur, migrations-OBJEKT, Byte-
  für-Byte-Determinismus (mit negativem Mutationstest), Safe-Settings-Pins,
  verbotene-Reads-Freiheit, Scope-Markierungen, SHA256SUMS.
- `tests/runner-orchestrator.test.mjs` — Failure-Injection State-Transition-Tests
  am ECHTEN Orchestrator: Erfolgsfall (Apply/Readback, kein Rollback), Prewrite-Drift
  (kein PUT), unbekannter PUT-Ausgang (kein Repeat, keine Aktion), PUT-ablehnt mit
  unverändertem Stand (kein Rollback), falsche Post-Write-Checks (eigene Version vs.
  fremd vs. alter Pin), Fremd-Deployment zwischen Apply und Rollback (STOP),
  Byte-Drift vor dem PUT, Allowlist-Ablehnungen, spotify-auth-Lauf-Ablehnung.
- Bestehende Suite: `node --test <file>` je Datei (siehe Commits; Fixture-Zählungen
  dieser Dateien nicht mit der Parent-Baseline mischen).

## Runner-Status (aktuell)

- **`recovery/runner.mjs` (alter PUT-Runner): NOT APPROVED — CLI eingefroren.**
  `node recovery/runner.mjs <worker> --execute` löst jetzt einen Fehler aus
  (fail closed). Die PUT-Response-`id` war der **Scriptname**, kein
  Versions-UUID; die Laufzeittests am historischen Orchestrator bleiben als
  Regressionsschutz bestehen, aber **es besteht kein ausführbares Freigabe-
  kriterium** für diesen Pfad mehr. Kein Deployment über diesen Runner.
- **`recovery/staged-runner.mjs` (neu, staged Versions-API): der einzige
  zustandsverändernde Pfad.** POST `versions?bindings_inherit=strict`
  (staged, inaktiv, `result.id` muss UUID sein), dann Receipt (wertfrei,
  `recovery/runs/`, O_EXCL|O_NOFOLLOW, 0600), dann
  POST `deployments` `{strategy:'percentage',versions:[{version_id:<own
  UUID>,percentage:100}],force:false}`. Upload-Metadaten enthalten NUR
  `main_module`, `compatibility_date`, `compatibility_flags`,
  `bindings` (`type:'inherit'`) — die Script-level-Settings
  (`observability`, `logpush`, `tags`, `tail_consumers`, `placement`) werden
  **nie** gesendet/gepatcht. Vor Upload/Aktivierung müssen die vollständigen
  Safe-Settings gleich sein; nach Aktivierung wird erneut Gleichheit geprüft.
  Recovery ist die bewusste Ausnahme: klassifizierter bekannter Settings-Drift
  erlaubt den Versionsrollback, unbekannte/unlesbare Settings stoppen ihn.
  Bleibt nach dem Rollback Drift bestehen, ist die Recovery **nicht verifiziert**;
  es folgt kein Settings-Write zur vermeintlichen Reparatur.
  `inherit` löst gegen die **LATEST UPLOAD** auf; strict schützt nur vor
  fehlender Auflösung, nicht vor latest≠active-Wertgleichheit — deshalb
  Guard `latest === pinned active` vor jedem Write, **phasenkorrekt**:
  nur VOR dem Upload gilt latest===alter Pin, danach (Aktivierung/Rollback)
  gilt latest===eigene UUID; ein fremder neuester Stand bleibt jederzeit STOP. Multipart-Modulparts
  tragen den **Dateinamen** als Feldnamen. Scope: **steam-/riot-proxy only**;
  Spotify-Worker werden strukturell abgelehnt, verbotene Reads
  (Versions-Detail, Spotify-Settings) sind nicht auf der Allowlist.
  Smoke-Tests laufen im selben Apply-Prozess über den injizierten
  Smoke-Callback; bei Smoke-Fail: guarded Rollback + Alt-Readback + Smoke.
  Auch Standalone-Rollback benötigt den Altversions-Smoke. Ein fehlgeschlagenes
  Apply endet **auch nach erfolgreicher Wiederherstellung mit Exit 1**; eine
  wiederhergestellte Altversion ist kein Deployment-Erfolg für den nächsten Worker.
  Unklarer Write-Ausgang: **kein** Retry, einmalige Klassifikation über die
  Versionsliste (Upload) bzw. Deployments (Aktivierung/Rollback); ein bestätigter
  Zustand benötigt anschließend die phasenspezifische Vollverifikation.
  Grenze ehrlich: Read-check-write ohne serverseitiges CAS
  ist **nicht atomar** — die frischen Guards je Write verkleinern das
  Fenster, sie schließen es nicht. **Parent-Review des exakten Runners vor
  jeder echten Invocation ist Pflicht**; ohne Freigabe läuft nur plan-only.

## Runbook (exakte Befehle, steam/riot zuerst)

```bash
# 0) Lokale Tests (kein Netz, kein CF)
node --test tests/recovery-payloads.test.mjs
node --test tests/staged-runner-orchestrator.test.mjs
node --test tests/oauthstate-miniflare.test.mjs
# Historisch (Regressionsschutz, KEIN Freigabe-Kriterium für runner.mjs):
node --test tests/runner-orchestrator.test.mjs

# 1) Staged-Runner-Planansicht (macht NICHTS ohne --execute/--rollback)
node recovery/staged-runner.mjs steam-proxy        # plan-only
node recovery/staged-runner.mjs riot-proxy         # plan-only

# 1a) ALTER PUT-Runner: EINGEFROREN (NOT APPROVED). "--execute" failt closed.
node recovery/runner.mjs steam-proxy --execute     # -> Fehler, keine Ausführung

# 2) Ausführung (erst nach Parent-Review des exakten staged-runners;
#    Env nur Prozess-ENV; Smokes laufen im selben Prozess)
CF_ACCOUNT_ID=<account-id> CF_API_TOKEN=<token> node recovery/staged-runner.mjs steam-proxy --execute
CF_ACCOUNT_ID=<account-id> CF_API_TOKEN=<token> node recovery/staged-runner.mjs riot-proxy --execute

# 2a) Standalone-Rollback einer eigenen aktivierten Version (Ownership-Guards)
CF_ACCOUNT_ID=<account-id> CF_API_TOKEN=<token> node recovery/staged-runner.mjs steam-proxy --rollback <receipt.json>
#    Quelle der Wahrheit ist das VERIFIZIERTE wertfreie Receipt (O_NOFOLLOW,
#    0600, Schema/Account/Worker/Alte-Pins/eigene UUID/Hashes). Eine beliebige
#    UUID wird NICHT als Ownership-Nachweis akzeptiert (kein receipt -> keine Writes).

# 3) spotify-proxy: NUR nach separater geprüfter Entscheidung (GATED_READ_SCOPE,
#    Binding-Drift ohne verbotene Reads unverifizierbar). Der staged-runner
#    lehnt den Worker strukturell ab; manuelle Uploads sind nicht Teil dieses Runbooks.

# 4) spotify-auth: NICHT FREIGEGEBEN (NOT_YET_APPROVED). Rollback-Template ist
#    bewusst nicht ausführbar (rollback_supported:false).
```

Der Parent reviewt den exakten Runner vor jeder Invocation. Keine Secrets in
Dateien/Logs; der Token lebt nur im Prozess-ENV des Runner-Aufrufs.

## Funktionstests nach Apply

riot: `/lol/Nirlau/Lauri/euw` 200 und ungültige Region 400; steam:
`/currently-playing?steamid=<gültige SteamID64>` 200 und `abc` 400 (siehe
`docs/cloudflare-write-plan.md` W1). Live-Baseline 24.11.2026 (Parent, read-only):
steam 200, riot 200, spotify `/now-playing` 403 mit und ohne Origin `https://nirlau.de`
— 403 ist VOR Deploy bestehend, kein Token-Read/Rotation daraus ableiten.

## Echte Grenzen

- Rollback über die Versions-API setzt Code+Bindings der gepinnten Version zurück,
  beweist aber **keine** Wiederherstellbarkeit von Secret-**Werten**; die Vault-
  Ablage enthält keine Spotify-/Steam-/Riot-Secretwerte (Stand 22.11.2026).
  Secret-Verlust bleibt operator-only behebbar.
- `spotify-auth`: KEIN supported Rollback (DO-Klassen-Lebenszyklus, siehe Scopes).
- Der DO-Migrations- und `OAUTH_STATE`-Payload ist gegen das offizielle Schema
  geprüft, aber **nicht produktiv verifiziert**.
- Keine Token-Rotation/Revocation; kein Frontend-Deploy (Frontend ist GitHub Pages,
  separat veröffentlicht bei SHA `714a656`; dieser Branch deployed es nicht);
  HSTS (W4) unverändert lassen.

## Recovery-Review und Kurskorrektur

Der ursprüngliche Auftrag ist die Fertigstellung der Website, nicht der Bau
eines allgemeinen Deployment-Frameworks. Das Frontend ist bereits separat live.
Der historische PUT-Pfad wurde verworfen, weil seine Antwort-ID keine Versions-ID
ist. Der staged Pfad blieb nach 137 bestandenen Tests im Review gesperrt:
Standalone-Rollback ohne Smoke, frei übernommene Fehlerfelder, nur syntaktische
Upload-Metadaten-Hashprüfung und falsche Versionszeitstempel-Fixtures.

Kurskorrektur: diese konkreten Lücken direkt beheben, keine zusätzlichen Modi,
Abhängigkeiten oder Recovery-Zweige. Upload-Metadata werden jetzt an einer Stelle
gebildet und beim Receipt-Lesen exakt neu gehasht; fremde Fehlerdaten erscheinen
nicht in Ausgaben. Frisches unabhängiges Review des gesamten exakten Pins bleibt
Pflicht. Bei erneutem grundlegenden Safety-Befund wird der Pfad eingefroren,
statt einen weiteren automatischen Recovery-Mechanismus anzubauen.
Die lokalen Implementierungs- und Testläufe dieses Worker-Branches führen keine
Cloudflare-Aufrufe aus. Der Parent hat separat read-only Live-Preflights ausgeführt;
Produktionsschreibzugriffe bleiben vom exakten Review-GO abhängig.

## Live-Versuch und sicherer Endzustand — 24.11.2026

- Ausgeführt wurde ausschließlich der von `reviewer-sol` (`tm_a82f36d71ab5`)
  technisch freigegebene Steam-Pfad bei Commit `cd89345`, über die gepinnte
  Credential-Bridge. Es gab genau einen Versionsupload, eine Aktivierung und
  einen guarded Versionsrollback; keinen Write-Retry und keinen Riot-Write.
- Neue Steam-Version `775ae326-f43b-4ba8-91bb-c0b5203a05a1` wurde zunächst bei
  100 Prozent aktiv bestätigt, Settings unverändert. Der anschließende
  öffentliche Smoke scheiterte mit der aggregierten Klasse `smoke_failed`.
  Welche Einzelprüfung scheiterte, wurde nicht aufgezeichnet: HTTP, Schema,
  ACAO und negative Eingabe bleiben mögliche, **nicht nachgewiesene** Ursachen.
- Guarded Recovery bestätigte die alte Version
  `6e8f4f79-f12c-4fd9-97f0-70da34d54b31` wieder bei 100 Prozent, neues
  Deployment `d0a26bf1-0645-4493-8422-deecd0e00861`, vollständige
  Settings-Gleichheit und bestandenen Altvertrags-Smoke. CLI endete korrekt
  mit Exit 1 / `apply_failed_recovered`. **Das ist kein erfolgreicher Rollout.**
- Das wertfreie Receipt liegt unter
  `recovery/runs/steam-proxy-775ae326-f43b-4ba8-91bb-c0b5203a05a1.json` (0600,
  gitignored). Die neue Version bleibt als **inaktiver neuester Upload** bestehen.
  Der alte Pre-Apply-Pin ist damit absichtlich nicht wiederverwendbar: aktive
  Deployment-ID und latest haben sich geändert. Kein blindes Wiederholen.
- Nach Recovery öffentlich erneut geprüft: Steam gültige Eingabe HTTP 200,
  ungültige Eingabe im alten Vertrag HTTP 200, Riot gültige Eingabe HTTP 200.
  Spotify/Auth/HSTS wurden nicht geändert.
- Zusätzlich besteht `tests/steam-runtime-smoke.test.mjs`: derselbe neue
  Steam-Code mit beiden expliziten ES-Modulen, gepinntem Kompatibilitätsdatum,
  Dummy-Key und gesperrtem echtem Upstream besteht den tatsächlichen
  `cliSmoke` in workerd/Miniflare (200 + Schema + ACAO, negative 400/no-store).
  Das belegt den isolierten Runtime-Vertrag, **nicht** die Live-Fehlerursache.
