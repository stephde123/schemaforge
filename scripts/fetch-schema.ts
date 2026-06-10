import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "../src/core/config.js";

/**
 * Downloads the official schema.org vocabulary (current, https flavor) so the
 * schema brain can validate types/properties precisely. Run once:
 *   pnpm fetch:schema
 */
const URL =
  "https://schema.org/version/latest/schemaorg-current-https.jsonld";

async function main() {
  const cfg = loadConfig();
  console.log(`Downloading schema.org vocabulary from ${URL} ...`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const text = await res.text();
  await mkdir(dirname(cfg.schemaDumpPath), { recursive: true });
  await writeFile(cfg.schemaDumpPath, text, "utf8");
  console.log(`Saved to ${cfg.schemaDumpPath} (${(text.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
