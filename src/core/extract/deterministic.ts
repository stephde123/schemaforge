import * as cheerio from "cheerio";
import type { Entity, NormalizedInput, DetectionResult } from "../types.js";
import type { PageClassification } from "../classify.js";

export function deterministicExtract(
  input: NormalizedInput,
  detection: DetectionResult,
  classification?: PageClassification,
): Entity[] {
  // 1) Collect existing JSON-LD — added at the END so fresh deterministic extraction
  // wins on conflicts (existing markup may be stale or have encoding issues), but
  // existing values still fill any gaps (e.g. @id, telephone) that we didn't extract.
  const existingEntities: Entity[] = [];
  for (const item of detection.existing) {
    if (item.format !== "json-ld") continue;
    for (const node of flattenJsonLd(item.data)) {
      const type = node["@type"];
      if (!type) continue;
      // Strip structural JSON-LD keys from props — @context belongs at document level only
      const { "@type": _t, "@id": id, "@context": _ctx, ...rest } = node;
      existingEntities.push({
        id: typeof id === "string" ? id : undefined,
        type,
        props: rest,
        _source: "existing",
      });
    }
  }

  if (!input.html) return existingEntities;

  const entities: Entity[] = [];

  const $ = cheerio.load(input.html);

  // 2) WebPage entity from meta/OG.
  const webPage: Entity = {
    type: "WebPage",
    props: pruneEmpty({
      name: input.title,
      url: input.canonicalUrl || input.sourceUrl,
      inLanguage: input.lang,
      description:
        $('meta[name="description"]').attr("content")?.trim() ||
        $('meta[property="og:description"]').attr("content")?.trim(),
      primaryImageOfPage: $('meta[property="og:image"]').attr("content")?.trim(),
    }),
    _source: "deterministic",
  };
  if (Object.keys(webPage.props).length > 1) entities.push(webPage);

  // 3) Breadcrumbs
  const crumbs = $(
    '[itemtype*="BreadcrumbList"] [itemprop="name"], nav.breadcrumb a, .breadcrumbs a, .breadcrumb a',
  )
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  if (crumbs.length) {
    entities.push({
      type: "BreadcrumbList",
      props: {
        itemListElement: crumbs.map((name, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name,
        })),
      },
      _source: "deterministic",
    });
  }

  // 4) Contact / address signals
  const tel = $('a[href^="tel:"]').first().attr("href")?.replace("tel:", "").trim();
  const email = $('a[href^="mailto:"]').first().attr("href")?.replace("mailto:", "").trim();
  if (tel || email) {
    entities.push({
      type: "Organization",
      props: pruneEmpty({ telephone: tel, email }),
      _source: "deterministic",
    });
  }

  // 5) SoftwareApplication entity + feature list
  const hint = classification?.primaryHint;
  const isApp =
    hint === "SoftwareApplication" ||
    hint === "WebApplication" ||
    hint === "MobileApplication" ||
    classification?.additionalHints.includes("SoftwareApplication");

  if (isApp) {
    const features = extractFeatureItems($, classification?.primaryHint === "SoftwareApplication" && /\/features?\//i.test(input.canonicalUrl || input.sourceUrl || ""));
    const appEntity: Entity = {
      type: "SoftwareApplication",
      props: pruneEmpty({
        name: softwareNameFromTitle(input.title),
        url: input.canonicalUrl || input.sourceUrl,
        description:
          $('meta[name="description"]').attr("content")?.trim() ||
          $('meta[property="og:description"]').attr("content")?.trim(),
        operatingSystem: detectOperatingSystem($, input.text || ""),
        applicationCategory: detectAppCategory($, input.text || ""),
        featureList: features.length ? features.map((f) => f.name).join(", ") : undefined,
        screenshot: $('meta[property="og:image"]').attr("content")?.trim(),
      }),
      _source: "deterministic",
    };
    entities.push(appEntity);

    // Feature list as structured ItemList — only when we actually found real features
    if (features.length >= 3) {
      entities.push({
        type: "ItemList",
        props: {
          name: "Features",
          url: input.canonicalUrl || input.sourceUrl,
          itemListElement: features.map((f, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: f.name,
            ...(f.description ? { description: f.description } : {}),
          })),
        },
        _source: "deterministic",
      });
    }
  }

  // 6) Pricing / Offer extraction
  const hasPricing =
    classification?.additionalHints.includes("Offer") ||
    classification?.signals.includes("pricing-signals");

  if (hasPricing) {
    const offers = extractPricingOffers($);
    for (const offer of offers) {
      entities.push({ type: "Offer", props: offer, _source: "deterministic" });
    }
  }

  // 7) FAQ extraction — also check page text for FAQ sections regardless of primary hint
  const hasFaq =
    hint === "FAQPage" ||
    classification?.additionalHints.includes("FAQPage") ||
    classification?.signals.includes("faq-content");
  if (hasFaq) {
    const qaPairs = extractFaqItems($);
    if (qaPairs.length >= 2) {
      entities.push({
        type: "FAQPage",
        props: {
          mainEntity: qaPairs.map((qa) => ({
            "@type": "Question",
            name: qa.question,
            acceptedAnswer: {
              "@type": "Answer",
              text: qa.answer,
            },
          })),
        },
        _source: "deterministic",
      });
    }
  }

  // 8) Article signals (author, datePublished)
  const isArticle =
    hint === "Article" ||
    hint === "BlogPosting" ||
    hint === "NewsArticle" ||
    classification?.additionalHints.includes("Article");
  if (isArticle) {
    const article = extractArticleMeta($, input);
    if (article) entities.push(article);
  }

  // 9) AggregateRating from visible star/review signals
  const hasRatings =
    classification?.additionalHints.includes("AggregateRating") ||
    classification?.signals.includes("review-signals");
  if (hasRatings) {
    const rating = extractAggregateRating($);
    if (rating) entities.push(rating);
  }

  // 10) Video objects
  if (classification?.additionalHints.includes("VideoObject")) {
    const videos = extractVideos($);
    entities.push(...videos);
  }

  // 11) Place / LocalBusiness / Church entity with postal address
  if (classification) {
    const placeEntity = extractPlaceEntity($, input, classification);
    if (placeEntity) entities.push(placeEntity);
  }

  // Existing JSON-LD fills gaps in freshly extracted entities (lower priority).
  return [...entities, ...existingEntities];
}

// ---------------------------------------------------------------------------
// Feature extraction helpers
// ---------------------------------------------------------------------------

interface FeatureItem {
  name: string;
  description?: string;
}

function isLikelyFeature(text: string): boolean {
  if (!text || text.length < 3 || text.length > 150) return false;
  if (text.endsWith("?") || text.endsWith(":")) return false; // FAQ question or label
  if (/^(home|back|next|previous|read more|learn more|click here|sign up|log in|get started)$/i.test(text)) return false;
  return true;
}

function extractFeatureItems($: cheerio.CheerioAPI, useListFallback = false): FeatureItem[] {
  const features: FeatureItem[] = [];
  const seen = new Set<string>();

  const addFeature = (name: string, desc?: string) => {
    const clean = name.trim();
    if (!isLikelyFeature(clean) || seen.has(clean)) return;
    seen.add(clean);
    features.push({ name: clean, description: desc?.slice(0, 300) || undefined });
  };

  // Strategy A: known feature-card containers
  const cardSelectors = [
    ".feature", ".features__item", ".feature-item", ".feature-card",
    '[class*="feature-card"]', '[class*="capability"]',
    ".ap-features-card",  // AdPresso / Oxygen builder pattern
  ];
  for (const sel of cardSelectors) {
    $(sel).each((_, el) => {
      const heading = $(el).find("h2, h3, h4, h5, strong").first().text().trim();
      const desc = $(el).find("p, .ct-text-block").first().text().trim();
      addFeature(heading, desc);
    });
    if (features.length >= 5) break;
  }

  // Strategy B: headings inside a #features / .features section
  if (features.length < 3) {
    $("#features, .features, section[id*='feature'], section[class*='feature']").each((_, section) => {
      $(section).find("h2, h3, h4").each((_, hEl) => {
        const text = $(hEl).text().trim();
        const desc = $(hEl).next("p").text().trim();
        addFeature(text, desc);
      });
    });
  }

  // Strategy C: list items — only on confirmed features pages, not on pricing/FAQ pages
  if (features.length < 3 && useListFallback) {
    $("ul li, ol li").each((_, el) => {
      const text = $(el).text().trim();
      if (!isLikelyFeature(text)) return;
      if (text.split(" ").length <= 12) addFeature(text);
    });
  }

  return features.slice(0, 40);
}

function detectOperatingSystem($: cheerio.CheerioAPI, text: string): string | undefined {
  const t = text.toLowerCase();
  const os: string[] = [];
  if (/wordpress/i.test(t)) os.push("WordPress");
  if (/\bios\b|\biphone\b|\bipad\b/i.test(t)) os.push("iOS");
  if (/\bandroid\b/i.test(t)) os.push("Android");
  if (/\bwindows\b/i.test(t)) os.push("Windows");
  if (/\bmacos\b|\bmac os\b|\bapple\s+mac/i.test(t)) os.push("macOS");
  if (/\blinux\b/i.test(t)) os.push("Linux");
  if (/\bweb(\s*app)?\b|\bbrowser\b/i.test(t)) os.push("Web");
  return os.length ? os.join(", ") : undefined;
}

function detectAppCategory($: cheerio.CheerioAPI, text: string): string | undefined {
  const t = text.toLowerCase();
  if (/ad\s*management|advertising|monetization/i.test(t)) return "BusinessApplication";
  if (/analytics|tracking|statistics/i.test(t)) return "BusinessApplication";
  if (/e-?commerce|shopping|woocommerce/i.test(t)) return "BusinessApplication";
  if (/seo|search\s+engine/i.test(t)) return "BusinessApplication";
  if (/social\s+media|instagram|twitter|facebook/i.test(t)) return "SocialNetworkingApplication";
  if (/email|newsletter|mail/i.test(t)) return "BusinessApplication";
  if (/design|photo|image|video\s+edit/i.test(t)) return "MultimediaApplication";
  if (/game|gaming/i.test(t)) return "GameApplication";
  if (/education|learning|course/i.test(t)) return "EducationalApplication";
  if (/health|fitness|medical/i.test(t)) return "HealthApplication";
  if (/finance|accounting|invoice/i.test(t)) return "FinanceApplication";
  if (/security|backup|protect/i.test(t)) return "SecurityApplication";
  if (/productivity|project\s+management|crm/i.test(t)) return "BusinessApplication";
  if (/developer|coding|programming/i.test(t)) return "DeveloperApplication";
  return "WebApplication";
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

type OfferProps = Record<string, unknown> & {
  name?: string;
  price?: string;
  priceCurrency?: string;
  description?: string;
};

/** Words that suggest a heading is a section label, not a plan name. */
const GENERIC_HEADING_PATTERN = /^(what (you )?get|includes?|everything( in)?|most popular|best value|recommended|our plans?|choose (a )?plan|pricing|get started|compare|tier|level|package)(\s|$)/i;

function extractPricingOffers($: cheerio.CheerioAPI): OfferProps[] {
  const offers: OfferProps[] = [];

  const tryCard = (el: any) => {
    const $el = $(el);
    const fullText = $el.text().replace(/\s+/g, " ");

    // Plan name: first heading, strip decorative content (SVG, icons, badges)
    let name: string | undefined;
    const headingEl = $el.find("h2, h3, h4, h5, [class*='plan-name'], [class*='plan-title'], [class*='tier-name']").first();
    if (headingEl.length) {
      name = headingEl.clone().find("svg, i, em, .badge, .tag, .label").remove().end()
        .text().replace(/\s+/g, " ").trim().replace(/^[^\w]+/, "") || undefined;
    }
    // Reject generic section headings and overly long strings (> 4 words = likely a sentence)
    if (name && (GENERIC_HEADING_PATTERN.test(name) || name.split(/\s+/).length > 4)) {
      name = undefined;
    }

    // Price: collect text from all leaf nodes, then fall back to full element text.
    // We do NOT strip children here — that breaks split-span patterns like <span>€</span>399.
    // Instead we scan sibling/parent text at increasing scope until we find currency+digits.
    let priceText = "";
    let currency = "USD";

    // Pass 1: look for a text node (or very shallow element) that already contains currency + digits together
    $el.find("*").each((_, child) => {
      const t = $(child).text().trim();
      if (/[€$£]\s*\d{2,}|\d{2,}\s*[€$£]|\d{2,}\s*(EUR|USD|GBP)\b/i.test(t) && t.length < 40) {
        priceText = t;
        return false as any;
      }
    });
    // Pass 2: currency symbol and digits may live in adjacent sibling spans — use full element text
    if (!priceText) {
      priceText = fullText;
    }

    // Extract currency symbol and numeric amount from whatever text we have
    const priceMatch =
      priceText.match(/([€$£])\s*(\d[\d,.]*)/) ||
      priceText.match(/(\d[\d,.]+)\s*([€$£])/) ||
      priceText.match(/(\d[\d,.]+)\s*(EUR|USD|GBP)\b/i);
    let rawPrice: string | undefined;
    if (priceMatch) {
      const sym = (priceMatch[1] || priceMatch[2]) ?? "";
      rawPrice = ((priceMatch[2] || priceMatch[1]) ?? "").replace(",", "");
      // Reject implausible prices (e.g. year numbers, zip codes)
      const num = parseFloat(rawPrice);
      if (num < 1 || num > 100000) rawPrice = undefined;
      if (rawPrice) {
        currency = /€|EUR/i.test(sym) ? "EUR" : /£|GBP/i.test(sym) ? "GBP" : "USD";
      }
    }

    // Period hint
    const period = /per\s+year|\/yr|annual/i.test($el.text()) ? "P1Y" : /per\s+month|\/mo/i.test($el.text()) ? "P1M" : undefined;

    // Sites / license count
    const sitesMatch = $el.text().match(/(\d+)\s+sites?/i);
    const description = sitesMatch ? `${sitesMatch[1]} site${Number(sitesMatch[1]) > 1 ? "s" : ""}` : undefined;

    if (name || rawPrice) {
      // price + priceCurrency stay on Offer for Google Rich Results compatibility.
      // Billing period goes into priceSpecification → UnitPriceSpecification.billingDuration
      // (billingIncrement is a property of UnitPriceSpecification, not Offer).
      const priceSpec = (rawPrice && period) ? {
        "@type": "UnitPriceSpecification",
        price: rawPrice,
        priceCurrency: currency,
        billingDuration: period,
      } : undefined;

      offers.push(pruneEmpty({
        name,
        price: rawPrice,
        priceCurrency: rawPrice ? currency : undefined,
        priceSpecification: priceSpec,
        eligibleQuantity: sitesMatch ? { "@type": "QuantitativeValue", value: Number(sitesMatch[1]) } : undefined,
        description,
      }) as OfferProps);
    }
  };

  // Specific known patterns first
  $(".ap-card").each((_, el) => tryCard(el));
  if (!offers.length) $(".pricing-plan, .plan, .price-card, .pricing-card, .pricing-tier, .plan-card").each((_, el) => tryCard(el));
  if (!offers.length) $('[class*="pricing-"], [class*="-plan"], [class*="-tier"]').each((_, el) => tryCard(el));

  // Generic: any section containing a price pattern and a heading
  if (!offers.length) {
    $("section, div").filter((_, el) => {
      const t = $(el).children().length;
      return t >= 2 && t <= 8 && /[€$£]\d{2,}/.test($(el).text());
    }).each((_, el) => tryCard(el));
  }

  return offers.filter((o) => o.name || o.price).slice(0, 10);
}

// ---------------------------------------------------------------------------
// FAQ helpers
// ---------------------------------------------------------------------------

interface QaPair {
  question: string;
  answer: string;
}

function extractFaqItems($: cheerio.CheerioAPI): QaPair[] {
  const pairs: QaPair[] = [];
  const seen = new Set<string>();

  const addPair = (q: string, a: string) => {
    if (!q || !a || seen.has(q)) return;
    seen.add(q);
    pairs.push({ question: q.trim(), answer: a.trim().slice(0, 600) });
  };

  // Schema.org microdata
  $('[itemtype*="Question"]').each((_, el) => {
    const q = $(el).find('[itemprop="name"]').first().text().trim();
    const a = $(el).find('[itemprop="acceptedAnswer"] [itemprop="text"], [itemprop="acceptedAnswer"]').first().text().trim();
    addPair(q, a);
  });

  // Common CMS / page-builder patterns
  $([
    ".faq-item", ".faq__item", "[class*='faq-item']",
    ".ap-features-card",      // Oxygen / AdPresso builder
    ".elementor-toggle-item", ".eael-accordion-list-item",
    "[data-faq]",
  ].join(", ")).each((_, el) => {
    const q = $(el).find("h3, h4, .faq-question, .question, .ct-headline, summary").first().text().trim();
    const a = $(el).find("p, .faq-answer, .answer, .ct-text-block, .toggle-content").first().text().trim();
    addPair(q, a);
  });

  // Generic accordion / details patterns
  if (pairs.length < 2) {
    $("details, .accordion-item, .toggle-item, [class*='accordion']").each((_, el) => {
      const q = $(el).find("summary, [class*='header'], [class*='title']").first().text().trim();
      const a = $(el).find("p, [class*='body'], [class*='content']").first().text().trim();
      addPair(q, a);
    });
  }

  // Last resort: any h3/h4 that ends with "?" followed by a paragraph
  if (pairs.length < 2) {
    $("h3, h4").each((_, el) => {
      const q = $(el).text().trim();
      if (!q.endsWith("?")) return;
      const a = $(el).next("p, div").first().text().trim();
      addPair(q, a);
    });
  }

  return pairs.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Article meta helpers
// ---------------------------------------------------------------------------

function extractArticleMeta(
  $: cheerio.CheerioAPI,
  input: NormalizedInput,
): Entity | null {
  const datePublished =
    $('meta[property="article:published_time"]').attr("content") ||
    $("time[datetime]").first().attr("datetime") ||
    undefined;
  const dateModified =
    $('meta[property="article:modified_time"]').attr("content") || undefined;
  const authorName =
    $('[rel="author"], .author, [itemprop="author"]').first().text().trim() ||
    $('meta[name="author"]').attr("content")?.trim() ||
    undefined;

  if (!datePublished && !authorName) return null;

  return {
    type: "Article",
    props: pruneEmpty({
      headline: input.title,
      url: input.canonicalUrl || input.sourceUrl,
      datePublished,
      dateModified,
      author: authorName
        ? { "@type": "Person", name: authorName }
        : undefined,
      image: $('meta[property="og:image"]').attr("content")?.trim(),
    }),
    _source: "deterministic",
  };
}

// ---------------------------------------------------------------------------
// AggregateRating helpers
// ---------------------------------------------------------------------------

function extractAggregateRating($: cheerio.CheerioAPI): Entity | null {
  const ratingEl = $('[itemtype*="AggregateRating"], [class*="rating"], [class*="stars"]').first();
  if (!ratingEl.length) return null;

  const ratingValue =
    ratingEl.find('[itemprop="ratingValue"]').text().trim() ||
    ratingEl.attr("data-rating") ||
    undefined;
  const reviewCount =
    ratingEl.find('[itemprop="reviewCount"], [itemprop="ratingCount"]').text().trim() ||
    undefined;

  if (!ratingValue) return null;
  return {
    type: "AggregateRating",
    props: pruneEmpty({
      ratingValue,
      reviewCount,
      bestRating: "5",
      worstRating: "1",
    }),
    _source: "deterministic",
  };
}

// ---------------------------------------------------------------------------
// Video helpers
// ---------------------------------------------------------------------------

function extractVideos($: cheerio.CheerioAPI): Entity[] {
  const videos: Entity[] = [];
  $("iframe[src*='youtube.com'], iframe[src*='vimeo.com'], video[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    const title = $(el).attr("title") || $(el).closest("[class]").find("h2,h3").first().text().trim() || undefined;
    if (!src) return;
    videos.push({
      type: "VideoObject",
      props: pruneEmpty({ name: title, embedUrl: src }),
      _source: "deterministic",
    });
  });
  return videos.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Name helpers
// ---------------------------------------------------------------------------

const GENERIC_PAGE_WORDS = /^(features?|pricing|plans?|download|about|contact|docs?|documentation|blog|news|faq|home|index|support|help|changelog|integrations?)$/i;

function softwareNameFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const parts = title.split(/\s*[-|–]\s*/);
  if (parts.length >= 2 && GENERIC_PAGE_WORDS.test((parts[0] ?? "").trim())) {
    // "Features - AdPresso" → "AdPresso"
    return parts.slice(1).join(" - ").trim();
  }
  // "AdPresso - Advanced Ad Management..." → "AdPresso"
  return (parts[0] ?? title).trim();
}

// ---------------------------------------------------------------------------
// Place / LocalBusiness helpers
// ---------------------------------------------------------------------------

function extractPlaceEntity(
  $: cheerio.CheerioAPI,
  input: NormalizedInput,
  classification: PageClassification,
): Entity | null {
  const isPlace =
    classification.signals.includes("place-of-worship") ||
    classification.signals.includes("postal-address-de") ||
    classification.primaryHint === "Church" ||
    classification.primaryHint === "LocalBusiness" ||
    classification.additionalHints.includes("PlaceOfWorship");

  if (!isPlace) return null;

  // Name: prefer h1, then og:title minus trailing " - site" suffix
  const h1 = $("h1").first().text().trim();
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();
  const name = (h1 || ogTitle?.replace(/\s*[-|–]\s*.+$/, "").trim() || input.title) || undefined;

  const description =
    $('meta[property="og:description"]').attr("content")?.trim() ||
    $('meta[name="description"]').attr("content")?.trim();

  const image = $('meta[property="og:image"]').attr("content")?.trim();
  const url = input.canonicalUrl || input.sourceUrl;
  const tel = $('a[href^="tel:"]').first().attr("href")?.replace("tel:", "").trim();
  const email = $('a[href^="mailto:"]').first().attr("href")?.replace("mailto:", "").trim();

  const address = extractPostalAddress($);

  const type =
    classification.primaryHint === "Church" ? "Church" :
    classification.additionalHints.includes("PlaceOfWorship") ? "PlaceOfWorship" :
    "LocalBusiness";

  const props = pruneEmpty({ name, description, url, image, telephone: tel, email, address });
  if (Object.keys(props).length < 2) return null;

  return { type, props, _source: "deterministic" };
}

/**
 * Extract a PostalAddress from footer / address / contact sections.
 * Supports German 5-digit PLZ ("56154 Boppard") and splits on <br> tags
 * to recover street + postal-code lines that cheerio .text() collapses.
 */
function extractPostalAddress($: cheerio.CheerioAPI): Record<string, unknown> | undefined {
  // 1) Schema.org microdata wins
  const micro = $('[itemtype*="PostalAddress"]').first();
  if (micro.length) {
    const props = pruneEmpty({
      "@type": "PostalAddress",
      streetAddress: micro.find('[itemprop="streetAddress"]').text().trim() || undefined,
      postalCode:    micro.find('[itemprop="postalCode"]').text().trim()    || undefined,
      addressLocality: micro.find('[itemprop="addressLocality"]').text().trim() || undefined,
      addressCountry: micro.find('[itemprop="addressCountry"]').text().trim()  || undefined,
    });
    if (Object.keys(props).length > 1) return props as Record<string, unknown>;
  }

  // 2) Scan footer and contact sections, splitting on <br> to recover address lines
  let streetAddress: string | undefined;
  let postalCode: string | undefined;
  let addressLocality: string | undefined;
  let addressCountry: string | undefined;

  $("footer p, address, [class*='footer'] p, [class*='contact'] p, [class*='address'] p").each((_, el) => {
    const lines = ($(el).html() || "")
      .split(/<br\s*\/?>/i)
      .map((l) => l.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, " ").trim())
      .filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // German PLZ: "56154 Boppard"
      const plz = line.match(/^(\d{5})\s+(.+)$/);
      if (plz) {
        postalCode = plz[1];
        addressLocality = plz[2]?.trim();
        addressCountry = "DE";
        if (i > 0) streetAddress = lines[i - 1];
        return false as any; // break cheerio.each
      }
      // US/CA ZIP: "Springfield, IL 62701" or "62701"
      const zip = line.match(/,\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
      if (zip) {
        postalCode = zip[2];
        addressLocality = line.replace(zip[0], "").trim();
        addressCountry = "US";
        if (i > 0) streetAddress = lines[i - 1];
        return false as any;
      }
    }
  });

  if (!postalCode && !streetAddress && !addressLocality) return undefined;
  return pruneEmpty({
    "@type": "PostalAddress",
    streetAddress,
    postalCode,
    addressLocality,
    addressCountry,
  }) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function flattenJsonLd(data: unknown): any[] {
  const out: any[] = [];
  const visit = (x: any) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(visit);
    if (Array.isArray(x["@graph"])) x["@graph"].forEach(visit);
    if (x["@type"]) out.push(x);
  };
  visit(data);
  return out;
}

function pruneEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && v !== "") out[k] = v;
  }
  return out as Partial<T>;
}
