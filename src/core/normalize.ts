import * as cheerio from "cheerio";
import type { Config } from "./config.js";
import type { NormalizedInput, WpSignals } from "./types.js";

export interface NormalizeRequest {
  url?: string;
  html?: string;
  extraText?: string;
  /** Caller-supplied language override (BCP-47). Takes precedence over HTML lang detection. */
  langOverride?: string;
  /** Authoritative CMS data from the WordPress companion plugin. */
  wpSignals?: WpSignals;
}

/**
 * Turn any of (URL | HTML | text) into a single NormalizedInput:
 * raw HTML, clean plain text, canonical URL, language, title.
 */
export async function normalize(
  req: NormalizeRequest,
  cfg: Config,
): Promise<NormalizedInput> {
  let html = req.html;
  let sourceUrl = req.url;

  if (req.url && !html) {
    html = await fetchHtml(req.url, cfg);
  }

  if (!html) {
    const userInstructions = req.extraText?.trim() || undefined;
    return {
      sourceUrl,
      text: userInstructions ?? "",
      userInstructions,
    };
  }

  const $ = cheerio.load(html);

  const canonicalUrl =
    $('link[rel="canonical"]').attr("href")?.trim() ||
    $('meta[property="og:url"]').attr("content")?.trim() ||
    sourceUrl;

  const lang =
    req.langOverride?.split("-")[0]?.trim() ||
    $("html").attr("lang")?.split("-")[0]?.trim() ||
    $('meta[property="og:locale"]').attr("content")?.split("_")[0]?.trim();

  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").first().text().trim() ||
    $("h1").first().text().trim();

  // Cleaned HTML for LLM (separate Cheerio instance — does not affect the $ below).
  const cleanedHtml = buildCleanedHtml(html);

  // Plain text for classification excerpts and fallback.
  $("script, style, noscript, template, svg").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const userInstructions = req.extraText?.trim() || undefined;
  const text = [bodyText, userInstructions].filter(Boolean).join("\n\n");

  return { canonicalUrl, sourceUrl, html, cleanedHtml, text, lang, title, userInstructions, wpSignals: req.wpSignals };
}

// ---------------------------------------------------------------------------
// HTML cleaner
// ---------------------------------------------------------------------------

/**
 * Attributes with genuine semantic value for schema.org extraction.
 * Everything else (class, id, style, data-*, event handlers, …) is stripped
 * to reduce token volume without sacrificing extraction quality.
 *
 * Kept attributes — rationale:
 *   href          → URL of links (sameAs, url, contactPoint targets)
 *   src           → media/image URL (ImageObject, VideoObject, AudioObject)
 *   alt           → image description (name/caption fallback)
 *   poster        → video thumbnail URL (VideoObject.thumbnailUrl)
 *   datetime      → machine-readable date on <time> (datePublished etc.)
 *   title         → tooltip/title text on any element
 *   lang          → language override on a subtree
 *   role          → ARIA landmark roles (navigation, article, main …)
 *   aria-label    → accessible label text (often better than visible text)
 *   itemprop      → Microdata property name  ─┐
 *   itemscope     → Microdata scope boundary  │ schema.org Microdata
 *   itemtype      → Microdata type URL        ─┘
 *   property      → RDFa property name        ─┐
 *   typeof        → RDFa type URI              │ RDFa
 *   content       → RDFa / <meta> machine value─┘
 *   name          → <meta name="description|author|…">
 *   rel           → link relationship (canonical, nofollow, author …)
 *   kind          → <track kind="subtitles|captions|descriptions">
 *   label         → <track label="Deutsch"> / <optgroup label>
 *   scope         → <th scope="col|row"> — table header semantics
 *   colspan       → table cell span — preserves table structure for LLM
 *   rowspan       → table cell span
 *   type          → <input type>, <link type>, keeps JSON-LD script[type]
 */
const SEMANTIC_ATTRS = new Set([
  "href", "src", "alt", "poster",
  "datetime",
  "title", "lang", "role", "aria-label",
  "itemprop", "itemscope", "itemtype",
  "property", "typeof", "content",
  "name", "rel",
  "kind", "label",
  "scope", "colspan", "rowspan",
  "type",
]);

/**
 * Returns a cleaned HTML string suitable for LLM consumption.
 *
 * Removes:  <style>, <script> (except JSON-LD), <noscript>, <template>,
 *           <canvas>, <iframe>, <map>, <area>, <svg>, HTML comments.
 * Keeps:    <video>, <audio> and their children (<source>, <track>) —
 *           these carry schema.org VideoObject / AudioObject signals.
 * Strips:   all attributes NOT in SEMANTIC_ATTRS (class, id, style,
 *           data-*, event handlers, srcset, loading, …).
 * Preserves all structural / semantic elements untouched (headings, lists,
 *           tables, nav, details/summary, figure, address, time, …).
 */
function buildCleanedHtml(rawHtml: string): string {
  const $ = cheerio.load(rawHtml);

  // Remove elements that add zero extraction value
  $("style, noscript, template, canvas, iframe, map, area, svg").remove();
  // Keep JSON-LD <script> tags — they let the LLM see what is already declared.
  $("script:not([type='application/ld+json'])").remove();

  // Strip non-semantic attributes from every element
  $("*").each((_, node) => {
    if (node.type !== "tag") return;
    const attribs = (node as unknown as { attribs: Record<string, string> }).attribs;
    for (const attr of Object.keys(attribs)) {
      if (!SEMANTIC_ATTRS.has(attr)) delete attribs[attr];
    }
  });

  return ($("body").html() ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")  // strip HTML comments
    .replace(/[ \t]{2,}/g, " ")       // collapse inline whitespace
    .trim();
}

// Patterns for private/reserved IPv4 ranges (RFC 1918, loopback, link-local).
const PRIVATE_IPV4_RE = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
];

// Reject URLs that point at loopback or private network addresses to prevent SSRF.
// Note: redirect-based SSRF (redirect from public → private URL) is not covered here;
// for full protection, resolve the hostname and check the resulting IP before each hop.
function assertSafeUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Protocol not allowed: ${parsed.protocol}`);
  }
  // URL.hostname includes brackets for IPv6 literals: [::1] — strip them.
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new Error("SSRF blocked: loopback address");
  }
  if (PRIVATE_IPV4_RE.some((re) => re.test(host))) {
    throw new Error("SSRF blocked: private IPv4 range");
  }
  // IPv6 ULA (fc00::/7) and link-local (fe80::/10)
  if (/^fe80/i.test(host) || /^f[cd]/i.test(host)) {
    throw new Error("SSRF blocked: private IPv6 range");
  }
}

async function fetchHtml(url: string, cfg: Config): Promise<string> {
  assertSafeUrl(url);
  const res = await fetch(url, {
    headers: { "User-Agent": cfg.fetchUserAgent, Accept: "text/html,*/*" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText} for ${url}`);
  }
  const reader = res.body?.getReader();
  if (!reader) return await res.text();

  // Cap how much we read so a giant page can't blow up memory.
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total > cfg.fetchMaxBytes) break;
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}
