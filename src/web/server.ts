import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { Engine } from "../core/engine.js";
import { toScriptTag } from "../core/serialize.js";
import { makeProviderFromKey } from "../core/llm/provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: API_VERSION } = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf8"),
) as { version: string };

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map<string, { user: string; expires: number }>();

const ContextSchema = z.object({
  /** Which SEO plugin is active on the WordPress site (e.g. "yoast", "rankmath"). */
  detectedPlugin: z.string().optional(),
  /** Caller's configured merge strategy hint. */
  strategy: z.enum(["auto", "merge", "replace", "add"]).optional(),
  /** BCP-47 language override (e.g. "de"). Overrides HTML lang detection. */
  lang: z.string().optional(),
}).optional();

const WpSignalsSchema = z.object({
  post: z.object({
    type:          z.string().optional(),
    title:         z.string().optional(),
    excerpt:       z.string().optional(),
    author:        z.object({ name: z.string().optional(), bio: z.string().optional(), url: z.string().optional() }).optional(),
    featuredImage: z.object({ url: z.string().optional(), alt: z.string().optional() }).optional(),
    publishedAt:   z.string().optional(),
    modifiedAt:    z.string().optional(),
  }).optional(),
  taxonomy: z.object({
    categories: z.array(z.string()).optional(),
    tags:       z.array(z.string()).optional(),
    custom:     z.record(z.array(z.string())).optional(),
  }).optional(),
  site: z.object({
    name:        z.string().optional(),
    description: z.string().optional(),
    url:         z.string().optional(),
    logo:        z.string().optional(),
  }).optional(),
  meta: z.record(z.unknown()).optional(),
  woocommerce: z.object({
    sku:          z.string().optional(),
    price:        z.string().optional(),
    regularPrice: z.string().optional(),
    salePrice:    z.string().optional(),
    currency:     z.string().optional(),
    availability: z.string().optional(),
    weight:       z.string().optional(),
    dimensions:   z.object({ length: z.string().optional(), width: z.string().optional(), height: z.string().optional() }).optional(),
    categories:   z.array(z.string()).optional(),
  }).optional(),
}).optional();

const RunSchema = z.object({
  url: z.string().url().optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  mode: z.enum(["auto", "deterministic"]).optional(),
  // User-supplied key for anonymous LLM access — never stored, one request only.
  apiKey: z.string().optional(),
  provider: z.enum(["openai", "anthropic"]).optional(),
  /** Optional context hints from the caller (e.g. WordPress companion plugin). */
  context: ContextSchema,
  /** Authoritative CMS data from the WordPress companion plugin. */
  wpSignals: WpSignalsSchema,
});

function getToken(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function getSession(req: express.Request): { user: string } | null {
  const token = getToken(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { user: s.user };
}

function requireSession(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!getSession(req)) return res.status(401).json({ error: "Not authenticated" });
  next();
}

async function main() {
  const cfg = loadConfig();
  const engine = await Engine.create(cfg);

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(express.static(join(__dirname, "public")));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, provider: cfg.llmProvider, version: API_VERSION, runCount: engine.getRunCount() });
  });

  app.delete("/api/registry", requireSession, async (_req, res) => {
    await engine.clearRegistry();
    res.json({ ok: true, message: "Registry cleared." });
  });

  app.get("/api/registry/stats", requireSession, (req, res) => {
    const entries = engine.getRegistryStats();
    const q = typeof req.query.q === "string" ? req.query.q.toLowerCase() : null;
    const filtered = q
      ? entries.filter(e => (e.name ?? "").toLowerCase().includes(q) || (e.type ?? "").toLowerCase().includes(q))
      : entries;
    res.json({ totalEntities: entries.length, runCount: engine.getRunCount(), recent: filtered.slice(0, 100) });
  });

  // Returns the current user if the session token is valid.
  app.get("/api/me", (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: "Not authenticated" });
    res.json({ user: session.user });
  });

  app.post("/api/login", (req, res) => {
    const { user, password } = req.body ?? {};
    if (user !== cfg.authUser || password !== cfg.authPassword) {
      return res.status(401).json({ error: "Falsche Zugangsdaten" });
    }
    const token = randomUUID();
    sessions.set(token, { user, expires: Date.now() + SESSION_TTL_MS });
    res.json({ token });
  });

  app.post("/api/logout", requireSession, (req, res) => {
    sessions.delete(getToken(req)!);
    res.json({ ok: true });
  });

  // Public endpoint — LLM access depends on auth state:
  //   logged in        → server's configured LLM (from .env)
  //   anonymous + key  → user's own key, one-shot provider
  //   anonymous no key → deterministic only
  app.post("/api/generate", async (req, res) => {
    const parsed = RunSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { url, html, text, mode, apiKey, provider: userProvider, context, wpSignals } = parsed.data;
    if (!url && !html && !text) {
      return res.status(400).json({ error: "Provide url, html, or text." });
    }

    const isLoggedIn = getSession(req) !== null;
    let llmOverride = undefined;
    let effectiveMode = mode;

    if (isLoggedIn) {
      // Use server's LLM — engine.run() will call this.llm (configured via .env).
    } else if (apiKey && userProvider) {
      llmOverride = makeProviderFromKey(userProvider, apiKey);
    } else {
      effectiveMode = "deterministic";
    }

    try {
      const result = await engine.run(
        { url, html, extraText: text, wpSignals: wpSignals ?? undefined },
        { mode: effectiveMode, llmOverride, requestContext: context ?? undefined },
      );
      res.json({
        recommendation: result.recommendation,
        usedMode: result.usedMode,
        detection: {
          hasExistingMarkup: result.detection.hasExistingMarkup,
          detectedPlugins: result.detection.detectedPlugins,
        },
        validation: result.validation,
        // Top-level aliases for convenience
        coverageScore: result.validation.coverageScore,
        classificationConfidence: result.classificationConfidence,
        jsonld: result.jsonld,
        scriptTag: toScriptTag(result.jsonld),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.listen(cfg.port, () => {
    console.log(
      `SchemaForge running on http://localhost:${cfg.port} (provider: ${cfg.llmProvider})`,
    );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
