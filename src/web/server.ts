import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
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

/**
 * Stateless HMAC-signed session tokens: `base64url(user).<expiryMs>.<sig>`.
 * No server-side store, so tokens survive a redeploy — the previous in-memory
 * Map silently invalidated every companion-plugin token on every deploy, and
 * /api/generate then treated the request as anonymous (→ deterministic).
 */
function createSessionAuth(secret: string) {
  const revoked = new Set<string>();
  const sign = (data: string) =>
    createHmac("sha256", secret).update(data).digest("base64url");

  return {
    issue(user: string): string {
      const payload = `${Buffer.from(user).toString("base64url")}.${Date.now() + SESSION_TTL_MS}`;
      return `${payload}.${sign(payload)}`;
    },
    verify(token: string | null): { user: string } | null {
      if (!token || revoked.has(token)) return null;
      const [u, exp, mac] = token.split(".");
      if (!u || !exp || !mac) return null;
      const expected = sign(`${u}.${exp}`);
      if (
        mac.length !== expected.length ||
        !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
      ) {
        return null;
      }
      if (!Number(exp) || Number(exp) < Date.now()) return null;
      return { user: Buffer.from(u, "base64url").toString() };
    },
    revoke(token: string | null) {
      if (token) revoked.add(token);
    },
  };
}

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
  seo: z.object({
    title:       z.string().optional(),
    description: z.string().optional(),
    canonical:   z.string().optional(),
    plugin:      z.string().optional(),
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
  blocks: z.array(z.object({
    name:      z.string(),
    ordered:   z.boolean().optional(),
    items:     z.array(z.string()).optional(),
    faqItems:  z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
    url:       z.string().optional(),
    alt:       z.string().optional(),
  })).optional(),
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
  events: z.object({
    startDate:  z.string().optional(),
    endDate:    z.string().optional(),
    timezone:   z.string().optional(),
    venue: z.object({
      name: z.string().optional(), address: z.string().optional(), city: z.string().optional(),
      zip: z.string().optional(), country: z.string().optional(), phone: z.string().optional(), url: z.string().optional(),
    }).optional(),
    organizer: z.object({
      name: z.string().optional(), email: z.string().optional(), url: z.string().optional(), phone: z.string().optional(),
    }).optional(),
    ticketUrl: z.string().optional(),
    cost:      z.string().optional(),
    status:    z.string().optional(),
    allDay:    z.boolean().optional(),
  }).optional(),
  courses: z.object({
    price:       z.string().optional(),
    currency:    z.string().optional(),
    duration:    z.string().optional(),
    level:       z.string().optional(),
    instructor:  z.string().optional(),
    maxStudents: z.string().optional(),
  }).optional(),
  jobs: z.object({
    jobType:    z.string().optional(),
    location:   z.string().optional(),
    salary:     z.string().optional(),
    company:    z.string().optional(),
    companyUrl: z.string().optional(),
    applyUrl:   z.string().optional(),
    remote:     z.boolean().optional(),
    expiryDate: z.string().optional(),
  }).optional(),
  edd: z.object({
    price:            z.string().optional(),
    currency:         z.string().optional(),
    downloadCategory: z.array(z.string()).optional(),
    downloadTag:      z.array(z.string()).optional(),
  }).optional(),
  ratings: z.object({
    average: z.number().optional(),
    count:   z.number().optional(),
    source:  z.string().optional(),
  }).optional(),
  localBusiness: z.object({
    categories:   z.array(z.string()).optional(),
    phone:        z.string().optional(),
    email:        z.string().optional(),
    website:      z.string().optional(),
    address:      z.string().optional(),
    city:         z.string().optional(),
    zip:          z.string().optional(),
    country:      z.string().optional(),
    openingHours: z.string().optional(),
    priceRange:   z.string().optional(),
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

/**
 * Sliding-window in-memory rate limiter. /api/generate fetches an arbitrary
 * remote URL and may call an LLM per request, so an unbounded public endpoint
 * is a real abuse vector. Keyed by client IP; authenticated callers get a
 * higher ceiling.
 */
function createRateLimiter(windowMs: number) {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();

  return function check(key: string, max: number): { ok: boolean; retryAfter: number } {
    const now = Date.now();

    if (now - lastSweep > windowMs) {
      for (const [k, ts] of hits) {
        const kept = ts.filter((t) => now - t < windowMs);
        if (kept.length) hits.set(k, kept);
        else hits.delete(k);
      }
      lastSweep = now;
    }

    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return { ok: false, retryAfter: Math.ceil((windowMs - (now - recent[0]!)) / 1000) };
    }
    recent.push(now);
    hits.set(key, recent);
    return { ok: true, retryAfter: 0 };
  };
}

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_ANON = 20;
const RATE_MAX_AUTHED = 120;

async function main() {
  const cfg = loadConfig();
  const engine = await Engine.create(cfg);

  const auth = createSessionAuth(
    process.env.AUTH_SECRET || `${cfg.authUser}::${cfg.authPassword}`,
  );
  const getSession = (req: express.Request) => auth.verify(getToken(req));
  const rateLimit = createRateLimiter(RATE_WINDOW_MS);
  const requireSession = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!getSession(req)) return res.status(401).json({ error: "Not authenticated" });
    next();
  };

  const app = express();
  app.set("trust proxy", 1); // one hop: nginx in front of the container
  app.use(express.json({ limit: "5mb" }));
  app.use(express.static(join(__dirname, "public")));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      provider: cfg.llmProvider,
      version: API_VERSION,
      runCount: engine.getRunCount(),
      schema: engine.getSchemaInfo(),
    });
  });

  app.delete("/api/registry", requireSession, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      const removed = await engine.pruneRegistry(q);
      return res.json({
        ok: true,
        removed,
        message: `Removed ${removed} registry entr${removed === 1 ? "y" : "ies"} matching "${q}".`,
      });
    }
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
    res.json({ token: auth.issue(user) });
  });

  app.post("/api/logout", requireSession, (req, res) => {
    auth.revoke(getToken(req));
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

    // A caller that sent a Bearer token expects authenticated behaviour. If it
    // no longer verifies (expired / server secret rotated), say so — don't
    // silently downgrade to an anonymous deterministic run.
    const token = getToken(req);
    const session = auth.verify(token);
    if (token && !session) {
      return res.status(401).json({ error: "Session abgelaufen — bitte neu einloggen." });
    }

    const isLoggedIn = session !== null;

    const rl = rateLimit(
      isLoggedIn ? `u:${session!.user}` : `ip:${req.ip}`,
      isLoggedIn ? RATE_MAX_AUTHED : RATE_MAX_ANON,
    );
    if (!rl.ok) {
      res.set("Retry-After", String(rl.retryAfter));
      return res.status(429).json({
        error: `Zu viele Anfragen — bitte in ${rl.retryAfter}s erneut versuchen.`,
      });
    }

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
        detectionSignals: result.detectionSignals,
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
