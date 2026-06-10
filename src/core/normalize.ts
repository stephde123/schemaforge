import * as cheerio from "cheerio";
import type { Config } from "./config.js";
import type { NormalizedInput } from "./types.js";

export interface NormalizeRequest {
  url?: string;
  html?: string;
  extraText?: string;
  /** Caller-supplied language override (BCP-47). Takes precedence over HTML lang detection. */
  langOverride?: string;
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
    // Pure text input (no markup to parse).
    return {
      sourceUrl,
      text: (req.extraText || "").trim(),
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

  // Strip noise, keep readable text.
  $("script, style, noscript, template, svg").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const text = [bodyText, req.extraText?.trim()].filter(Boolean).join("\n\n");

  return { canonicalUrl, sourceUrl, html, text, lang, title };
}

async function fetchHtml(url: string, cfg: Config): Promise<string> {
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
