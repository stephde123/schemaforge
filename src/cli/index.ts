import { readFile } from "node:fs/promises";
import { loadConfig } from "../core/config.js";
import { Engine } from "../core/engine.js";
import { toScriptTag } from "../core/serialize.js";

/**
 * Usage:
 *   pnpm cli --url https://example.com/seite
 *   pnpm cli --html ./page.html --text "Zusatzinfos"
 *   pnpm cli --url https://example.com --deterministic
 *   pnpm cli --url https://example.com --script   (output <script> tag)
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url && !args.html && !args.text) {
    console.error("Provide --url, --html <file>, or --text <string>.");
    process.exit(1);
  }

  const cfg = loadConfig();
  const engine = await Engine.create(cfg);

  const html = args.html ? await readFile(args.html, "utf8") : undefined;

  const result = await engine.run(
    { url: args.url, html, extraText: args.text },
    { mode: args.deterministic ? "deterministic" : "auto" },
  );

  console.error("\n--- Detection ---");
  console.error(
    `existing markup: ${result.detection.hasExistingMarkup} | plugins: ${result.detection.detectedPlugins.join(", ") || "none"} | recommendation: ${result.recommendation}`,
  );
  console.error("\n--- Validation ---");
  console.error(`coverage: ${result.validation.coverageScore}`);
  for (const i of result.validation.issues) {
    console.error(`  [${i.level}] ${i.subject ? i.subject + ": " : ""}${i.message}`);
  }
  console.error("\n--- JSON-LD ---");
  console.log(args.script ? toScriptTag(result.jsonld) : JSON.stringify(result.jsonld, null, 2));
}

function parseArgs(argv: string[]) {
  const out: {
    url?: string;
    html?: string;
    text?: string;
    deterministic?: boolean;
    script?: boolean;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--html") out.html = argv[++i];
    else if (a === "--text") out.text = argv[++i];
    else if (a === "--deterministic") out.deterministic = true;
    else if (a === "--script") out.script = true;
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
