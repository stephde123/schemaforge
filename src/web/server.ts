import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { Engine } from "../core/engine.js";
import { toScriptTag } from "../core/serialize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RunSchema = z.object({
  url: z.string().url().optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  mode: z.enum(["auto", "deterministic"]).optional(),
});

async function main() {
  const cfg = loadConfig();
  const engine = await Engine.create(cfg);

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(express.static(join(__dirname, "public")));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, provider: cfg.llmProvider });
  });

  app.post("/api/generate", async (req, res) => {
    const parsed = RunSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { url, html, text, mode } = parsed.data;
    if (!url && !html && !text) {
      return res.status(400).json({ error: "Provide url, html, or text." });
    }
    try {
      const result = await engine.run({ url, html, extraText: text }, { mode });
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
    console.log(`SchemaForge running on http://localhost:${cfg.port} (provider: ${cfg.llmProvider})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
