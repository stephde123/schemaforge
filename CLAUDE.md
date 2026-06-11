# SchemaForge — CLAUDE.md

## Repos & Deployment

| Repo | Path (lokal) | Deployed via |
|------|-------------|--------------|
| **schemaforge** (Node API + UI) | `F:/Server/schemaforge` | Push → `main` → GitHub Actions → Docker → DigitalOcean Droplet Port 8420 |
| **schemaforge-wp** (WP Plugin) | `F:/Server/schemaforge-wp` | Push → `main` → GitHub Actions (ZIP build + release) |

Beide Repos deployen automatisch bei Push auf `main` — kein manueller SSH-Schritt nötig.

**WP-Plugin-Release-Workflow:** Version bumpen (`schemaforge-wp.php` + `readme.txt` stable tag + Changelog-Eintrag) → committen → Tag setzen. Erst dann pushen.

---

## schemaforge (Node-Server)

### Stack
- **Runtime:** Node.js (ESM), TypeScript via `tsx`
- **Server:** Express 4, Port 8420
- **LLM:** Anthropic (`claude-sonnet-4-20250514`) oder OpenAI (`gpt-4o`), konfigurierbar per `.env`
- **Package Manager:** pnpm 11
- **Kein Build-Step** — `tsx` transpiliert zur Laufzeit

### Dateistruktur

```
src/
  cli/
    index.ts          # CLI-Einstieg (pnpm cli)
  core/
    types.ts          # Alle Domain-Typen (Entity, PipelineResult, …)
    config.ts         # loadConfig() liest .env
    engine.ts         # Engine-Klasse: orchestriert die Pipeline, hält Brain + Registry
    normalize.ts      # URL-Fetch oder HTML-Cleanup → NormalizedInput
    detect.ts         # Erkennt vorhandenes Markup (JSON-LD/Microdata/RDFa) + SEO-Plugins
    classify.ts       # Heuristischer Seitentyp-Klassifizierer
    classify-llm.ts   # LLM-basierter Typ-Selektor (alle 932 schema.org-Typen im System-Prompt)
    reconcile.ts      # Entity-Dedup + @id-Vergabe + Registry-Lookup
    validate.ts       # Coverage-Score + missingRequired
    serialize.ts      # toJsonLd() + toScriptTag()
    schema-brain.ts   # Lädt schemaorg-current-https.jsonld, cached
    registry.ts       # JsonRegistry: key → {id, type, name, firstSeen, lastSeen} in data/registry.json
    extract/
      deterministic.ts  # Regex/Cheerio-Extraktion ohne LLM
      llm.ts            # LLM-Tiefen-Extraktion (Entity-Filling)
    llm/
      provider.ts       # LlmProvider-Interface + makeProvider() / makeProviderFromKey()
      anthropic.ts      # Anthropic-Adapter
      openai.ts         # OpenAI-Adapter
  web/
    server.ts         # Express-Server: alle API-Routen
    public/           # Statische UI-Dateien (HTML/JS/CSS)
scripts/
  fetch-schema.ts     # Lädt schemaorg-current-https.jsonld herunter
  bump-patch.mjs      # Patch-Version hochzählen
  entrypoint.sh       # Docker-Entrypoint
data/
  registry.json       # Persistent: key→id-Mapping (Entity-Gedächtnis)
  schemaorg-current-https.jsonld  # Schema.org-Vokabular-Dump (~5 MB)
```

### API-Routen (server.ts)

| Methode | Route | Auth | Beschreibung |
|---------|-------|------|--------------|
| GET | `/api/health` | nein | Status, Provider, Version, runCount |
| POST | `/api/login` | nein | Gibt Session-Token (24h TTL) zurück |
| POST | `/api/logout` | Session | Invalidiert Token |
| GET | `/api/me` | Session | Prüft ob Session gültig |
| POST | `/api/generate` | optional | Hauptendpoint: erzeugt JSON-LD |
| GET | `/api/registry/stats` | Session | Registry-Inhalt, filterbar per `?q=` |
| DELETE | `/api/registry` | Session | Registry leeren |

`/api/generate`-Logik:
- Eingeloggt → Server-LLM (aus `.env`)
- Anonym + `apiKey` + `provider` → One-Shot mit eigenem Key
- Anonym ohne Key → automatisch `mode=deterministic`

### Pipeline (Engine.run)

```
1. normalize    → NormalizedInput (fetch/clean HTML, lang-Erkennung)
2. detect       → DetectionResult (vorhandenes Markup, SEO-Plugins)
3. classify     → Seitentyp-Hint (heuristisch oder LLM)
4. deterministicExtract → Entity[] (Cheerio/Regex)
5. llmExtract   → Entity[] (LLM-Tiefe, appendiert)
6. manualEntities (aus opts, appendiert)
7. reconcile    → EntityGraph (Dedup, @id, Registry-Upsert)
8. validate     → ValidationReport (Coverage-Score, missingRequired)
9. serialize    → JSON-LD + <script>-Tag
```

### .env-Variablen

```
LLM_PROVIDER=anthropic|openai|none
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
PORT=8420
FETCH_USER_AGENT=SchemaForgeBot/0.1
FETCH_MAX_BYTES=3000000
REGISTRY_PATH=./data/registry.json
SCHEMA_DUMP_PATH=./data/schemaorg-current-https.jsonld
AUTH_USER=stephan
AUTH_PASSWORD=TestSchemaForge
```

### npm-Scripts

```
pnpm dev          # tsx watch (Hot-Reload)
pnpm web          # tsx (einmalig)
pnpm cli          # CLI-Mode
pnpm fetch:schema # Schema.org-Dump aktualisieren
pnpm typecheck    # tsc --noEmit
```

### Registry-Invariante

Die Registry speichert **nur** `key → id`. Keine Properties, keine LLM-Antworten. Grund: Properties sind immer aktuell von der aktuellen Seite maßgeblich — akkumulierte Props aus früheren Runs würden veraltete oder halluzinierte Werte perpetuieren.

---

## schemaforge-wp (WordPress Plugin)

### Stack
- **PHP:** 8.1+
- **WordPress:** 6.4+
- **Kein Build-Step**, kein Composer
- Autoloader: `SchemaForge_WP_*` → `includes/class-*.php`

### Dateistruktur

```
schemaforge-wp.php          # Plugin-Header, Konstanten, Autoloader, Bootstrap
includes/
  class-api-client.php      # HTTP-Calls zu /api/login + /api/generate (mit Token-Cache)
  class-detector.php        # Erkennt aktive SEO-Plugins (Yoast, RankMath, …) auf dem Post
  class-encryption.php      # Verschlüsselt gespeicherte API-Credentials (AES via openssl)
  class-generator.php       # Orchestriert: wann + wie Schema für einen Post erzeugt wird
  class-metabox.php         # Admin-Metabox (manueller Trigger + Status-Anzeige)
  class-output.php          # Gibt <script type="application/ld+json"> im Frontend aus
  class-rest.php            # Eigener WP REST-Endpoint (z.B. für Gutenberg-Block)
  class-settings.php        # Admin-Einstellungsseite (Endpoint-URL, Credentials, Mode)
assets/
  admin.css
  admin.js                  # JS für Metabox-AJAX + Settings-Seite
languages/                  # .pot / .po Dateien
readme.txt                  # WordPress.org Readme (stable tag hier aktuell halten!)
```

### Wichtige Konstanten (schemaforge-wp.php)

```php
SCHEMAFORGE_WP_VERSION      // '1.2.2'
SCHEMAFORGE_WP_DIR          // Absoluter Plugin-Pfad
SCHEMAFORGE_WP_URL          // Plugin-URL
SCHEMAFORGE_WP_ENDPOINT     // Standard: 'http://64.226.96.241:8420'
                             // Überschreibbar per wp-config.php
SCHEMAFORGE_WP_CRON_HOOK    // 'schemaforge_wp_generate_event'
```

### Auth-Flow (API-Client)

Session-Token wird als WP-Transient gecached (`sfwp_token_<md5(endpoint|user)>`, TTL 23h). Bei Ablauf oder Fehler → erneuter Login → Token-Update.

### Coding-Konventionen (beide Repos)

- TypeScript: ESM-Module, kein CommonJS, Imports mit `.js`-Extension
- PHP: PSR-4-ähnlich (eine Klasse pro Datei, Dateiname = `class-kebab-case.php`)
- Keine Kommentare außer wenn das **Warum** nicht offensichtlich ist
- Keine Backward-Compat-Shims für entfernten Code
- Kein Error-Handling für Szenarien die nie eintreten können
- Validierung nur an System-Grenzen (User-Input, externe APIs)
