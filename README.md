# SchemaForge

Erzeugt tiefes, sehr spezifisches **schema.org / JSON-LD**-Markup aus einer URL,
HTML oder Freitext. Erkennt vorhandenes Markup (inkl. WordPress-Plugin-Fingerprint),
extrahiert deterministisch **und** LLM-gestützt, verknüpft Entitäten über stabile
`@id`s und merkt sich Entitäten seitenübergreifend (Registry/„Gedächtnis").

## Pipeline

```
Input → Normalize → Detect → Extract(deterministisch + LLM) → Reconcile(IDs+Memory) → Validate → JSON-LD
```

- **Normalize** (`src/core/normalize.ts`): URL fetchen oder HTML/Text annehmen, Canonical/Sprache/Titel + Klartext.
- **Detect** (`src/core/detect.ts`): bestehendes JSON-LD/Microdata/RDFa, Plugin-Fingerprint (Yoast, Rank Math, …) → Empfehlung add/merge/replace.
- **Extract**: `extract/deterministic.ts` (OG/Meta/Breadcrumbs/Kontakt) + `extract/llm.ts` (Tiefe, eingeengt durch das Schema-Brain).
- **Schema-Brain** (`src/core/schema-brain.ts`): lädt den offiziellen schema.org-Dump, kennt Typhierarchie + gültige Properties.
- **Reconcile** (`src/core/reconcile.ts`): dedupe, stabile `@id`s minten, Entity-Resolution gegen die **Registry** (`registry.ts`).
- **Validate** (`src/core/validate.ts`): Typ/Property-Gültigkeit + Google-Required-Felder + Coverage-Score.

## Lokal starten (Windows 10 / WSL2)

```bash
corepack enable
pnpm install
cp .env.example .env        # API-Key eintragen, LLM_PROVIDER wählen
pnpm fetch:schema           # einmalig: schema.org-Vokabular laden
pnpm dev                    # Web-UI auf http://localhost:8420
```

CLI:

```bash
pnpm cli --url https://example.com/seite
pnpm cli --url https://example.com --script        # gibt fertiges <script>-Tag aus
pnpm cli --html ./page.html --text "Zusatzinfos"
pnpm cli --url https://example.com --deterministic # ohne LLM
```

## LLM-Provider

In `.env`: `LLM_PROVIDER=anthropic | openai | none`.
- `anthropic` nutzt die **Anthropic Messages API** (nicht Claude Code — das ist das Build-Tool).
- `openai` nutzt `chat.completions` mit JSON-Mode.
- `none` = nur deterministisch (kein Token-Verbrauch).

## Deploy auf bestehendem DigitalOcean-Droplet (Docker läuft schon)

Funktioniert problemlos neben deinem anderen Projekt. Zwei Punkte beachten:
**Port** und **Reverse Proxy**.

```bash
# auf dem Droplet
git clone <dein-repo> schemaforge && cd schemaforge
cp .env.example .env   # Keys + PORT setzen (z.B. 8420, kollisionsfrei!)
docker compose up -d --build
docker compose exec schemaforge pnpm fetch:schema   # Vokabular einmalig laden
```

Der Container bindet absichtlich nur an `127.0.0.1:8420`. Dein vorhandener
Reverse Proxy hängt sich davor:

**Caddy** (`Caddyfile`):
```
schemaforge.deine-domain.de {
    reverse_proxy 127.0.0.1:8420
}
```

**nginx**:
```nginx
server {
    server_name schemaforge.deine-domain.de;
    location / { proxy_pass http://127.0.0.1:8420; proxy_set_header Host $host; }
}
```

Falls dein anderes Projekt **Traefik** nutzt, stattdessen Labels am Service in
`docker-compose.yml` ergänzen und das `ports`-Mapping weglassen.

## Push-to-Deploy (Live-Loop)

`.github/workflows/ci.yml` macht Typecheck bei jedem Push. Für automatisches
Deploy ergänzen wir später einen Step, der per SSH auf dem Droplet
`git pull && docker compose up -d --build` ausführt. Dann: Code pushen →
Subdomain neu laden → JSON-LD im Google Rich Results Test gegenchecken.

## Roadmap (nächste Stufen)

1. Manueller Editor in der UI (Entitäten von Hand ergänzen/überschreiben).
2. Diff-Ansicht: bestehendes Markup vs. neues Markup.
3. SQLite-Registry statt JSON (gleiches Interface).
4. Local-LLM-Option (Ollama) für DSGVO-sensible Inhalte.
5. Monorepo-Split + WordPress-Plugin-Hülle (AdPresso-Nähe).
6. Erweiterte Google-Required-Tabelle + sameAs-Anreicherung via Wikidata.
```
