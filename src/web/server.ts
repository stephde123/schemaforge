import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { Engine } from "../core/engine.js";
import { toScriptTag } from "../core/serialize.js";
import { makeProviderFromKey } from "../core/llm/provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// In-memory session store: token → { user, expires }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map<string, { user: string; expires: number }>();

const RunSchema = z.object({
  url: z.string().url().optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  mode: z.enum(["auto", "deterministic"]).optional(),
  // User's own API key for LLM mode — never stored, only used for this request.
  apiKey: z.string().optional(),
  provider: z.enum(["openai", "anthropic"]).optional(),
});

function getToken(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function requireSession(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "Session expired" });
  }
  next();
}

async function main() {
  const cfg = loadConfig();
  const engine = await Engine.create(cfg);

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(express.static(join(__dirname, "public")));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, provider: cfg.llmProvider });
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
    const token = getToken(req)!;
    sessions.delete(token);
    res.json({ ok: true });
  });

  app.post("/api/generate", requireSession, async (req, res) => {
    const parsed = RunSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { url, html, text, mode, apiKey, provider: userProvider } = parsed.data;
    if (!url && !html && !text) {
      return res.status(400).json({ error: "Provide url, html, or text." });
    }

    // Build a per-request provider from the user's own key.
    // The server's own API key is never used for web requests.
    let llmOverride = undefined;
    let effectiveMode = mode;

    if (apiKey && userProvider) {
      llmOverride = makeProviderFromKey(userProvider, apiKey);
    } else {
      effectiveMode = "deterministic";
    }

    try {
      const result = await engine.run(
        { url, html, extraText: text },
        { mode: effectiveMode, llmOverride },
      );
      res.json({
        recommendation: result.recommendation,
        detection: {
          hasExistingMarkup: result.detection.hasExistingMarkup,
          detectedPlugins: result.detection.detectedPlugins,
        },
        validation: result.validation,
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
