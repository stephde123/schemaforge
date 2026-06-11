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

  // --- Microdata (extract itemprop values from each itemscope element) ---
  for (const item of extractMicrodataItems($)) {
    existing.push(item);
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

function extractMicrodataItems($: cheerio.CheerioAPI): ExistingMarkupItem[] {
  const items: ExistingMarkupItem[] = [];

  // Process only top-level [itemscope] elements (skip elements nested inside another itemscope)
  for (const root of $("[itemscope]").not("[itemscope] [itemscope]").toArray()) {
    const $root = $(root);
    const itemtype = $root.attr("itemtype") ?? "";
    const typeMatch = itemtype.match(/schema\.org\/(\w+)/);
    if (!typeMatch) continue;

    const data: Record<string, unknown> = { "@type": typeMatch[1] };

    // Collect itemprop descendants that are NOT inside a nested itemscope
    for (const el of $root.find("[itemprop]").toArray()) {
      if ($(el).parentsUntil($root, "[itemscope]").length > 0) continue;

      const $el  = $(el);
      const prop = $el.attr("itemprop");
      if (!prop) continue;

      const tag = (el as unknown as { tagName?: string }).tagName?.toLowerCase() ?? "";
      let val: string | undefined;
      if (tag === "meta")       val = $el.attr("content");
      else if (tag === "link")  val = $el.attr("href");
      else if (tag === "a")     val = $el.attr("href") ?? $el.text().trim();
      else if (tag === "img")   val = $el.attr("src");
      else if (tag === "time")  val = $el.attr("datetime") ?? $el.text().trim();
      else                      val = $el.text().trim() || undefined;

      if (val) data[prop] = val;
    }

    if (Object.keys(data).length > 1) {
      items.push({ format: "microdata", data, plugin: "unknown" });
    }
  }

  return items;
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
