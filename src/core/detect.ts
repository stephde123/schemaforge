import * as cheerio from "cheerio";
import type {
  DetectionResult,
  ExistingMarkupItem,
  SchemaPlugin,
} from "./types.js";

/**
 * Detect existing structured data and fingerprint which WP plugin/theme
 * produced it. This drives the add/merge/replace recommendation later.
 */
export function detect(html?: string): DetectionResult {
  if (!html) {
    return { existing: [], detectedPlugins: [], hasExistingMarkup: false };
  }

  const $ = cheerio.load(html);
  const existing: ExistingMarkupItem[] = [];
  const plugins = new Set<SchemaPlugin>();

  // --- JSON-LD ---
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const plugin = fingerprintJsonLd(data, $);
      plugins.add(plugin);
      existing.push({ format: "json-ld", data, plugin });
    } catch {
      // Malformed JSON-LD is itself a finding; record it loosely.
      existing.push({ format: "json-ld", data: raw, plugin: "unknown" });
    }
  });

  // --- Microdata (presence only for v1) ---
  if ($("[itemscope]").length > 0) {
    existing.push({
      format: "microdata",
      data: { itemscopeCount: $("[itemscope]").length },
      plugin: "unknown",
    });
  }

  // --- RDFa (presence only for v1) ---
  if ($("[typeof], [property][content]").filter("[typeof]").length > 0) {
    existing.push({ format: "rdfa", data: {}, plugin: "unknown" });
  }

  // --- Generator / theme fingerprints (independent of markup) ---
  fingerprintEnvironment($, plugins);

  return {
    existing,
    detectedPlugins: [...plugins],
    hasExistingMarkup: existing.length > 0,
  };
}

function fingerprintJsonLd(
  data: unknown,
  $: cheerio.CheerioAPI,
): SchemaPlugin {
  const json = JSON.stringify(data);

  // Yoast: @graph with /#/schema/ ids and #website / #webpage fragments.
  if (/\/#\/schema\//.test(json) || /#website|#webpage|#organization/.test(json)) {
    if ($('meta[name="generator"][content*="Yoast" i]').length || /yoast/i.test(json)) {
      return "yoast";
    }
  }
  if (/rank ?math/i.test(json) || $('meta[name="generator"][content*="Rank Math" i]').length) {
    return "rankmath";
  }
  if (/aioseo|all in one seo/i.test(json)) return "aioseo";
  // Schema Pro tends to emit plain typed objects without a @graph wrapper.
  if (/wp-schema-pro|bsf/i.test(json)) return "schema-pro";
  if (/the seo framework|autodescription/i.test(json)) return "the-seo-framework";

  return "wordpress-generic";
}

function fingerprintEnvironment(
  $: cheerio.CheerioAPI,
  plugins: Set<SchemaPlugin>,
): void {
  const gen = $('meta[name="generator"]').attr("content") || "";
  if (/yoast/i.test(gen)) plugins.add("yoast");
  if (/rank math/i.test(gen)) plugins.add("rankmath");
  if (/all in one seo/i.test(gen)) plugins.add("aioseo");
  if (/wordpress/i.test(gen) || $('link[href*="/wp-content/"]').length) {
    plugins.add("wordpress-generic");
  }
}
