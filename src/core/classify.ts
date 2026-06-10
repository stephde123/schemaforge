import type { NormalizedInput } from "./types.js";

export interface PageClassification {
  primaryHint: string;
  additionalHints: string[];
  signals: string[];
}

/**
 * URL-path rules: [pattern, primaryType, additionalTypes]
 * Order matters — first match wins for primaryHint.
 */
const URL_RULES: [RegExp, string, string[]][] = [
  [/\/features?\/?(\?.*)?$/i,  "SoftwareApplication", ["ItemList"]],
  [/\/pricing\/?(\?.*)?$/i,    "SoftwareApplication", ["Offer", "AggregateOffer", "PriceSpecification"]],
  [/\/plans?\/?(\?.*)?$/i,     "SoftwareApplication", ["Offer", "AggregateOffer"]],
  [/\/download\/?(\?.*)?$/i,   "SoftwareApplication", []],
  [/\/integrations?\/?/i,      "SoftwareApplication", ["ItemList"]],
  [/\/changelog\/?/i,          "SoftwareApplication", ["TechArticle"]],
  [/\/docs?\/?/i,              "TechArticle",         ["HowTo", "SoftwareApplication"]],
  [/\/tutorial\/?/i,           "HowTo",               ["TechArticle"]],
  [/\/how-to\/?/i,             "HowTo",               []],
  [/\/recipe\/?/i,             "Recipe",              []],
  [/\/product\//i,             "Product",             ["Offer"]],
  [/\/shop\/?/i,               "Product",             ["Offer", "ItemList"]],
  [/\/(blog|posts?)\//i,       "BlogPosting",         ["Article"]],
  [/\/news\//i,                "NewsArticle",         ["Article"]],
  [/\/press\//i,               "NewsArticle",         ["Article"]],
  [/\/events?\//i,             "Event",               []],
  [/\/webinar\/?/i,            "OnlineEvent",         ["Event"]],
  [/\/jobs?\/?/i,              "JobPosting",          []],
  [/\/careers?\/?/i,           "JobPosting",          ["Organization"]],
  [/\/faq\/?(\?.*)?$/i,        "FAQPage",             ["Question"]],
  [/\/about\/?(\?.*)?$/i,      "AboutPage",           ["Organization", "Person"]],
  [/\/contact\/?(\?.*)?$/i,    "ContactPage",         ["LocalBusiness", "Organization"]],
  [/\/team\/?(\?.*)?$/i,       "AboutPage",           ["Person"]],
  [/\/review\//i,              "Review",              ["AggregateRating"]],
  [/\/course\/?/i,             "Course",              ["EducationEvent"]],
  [/\/podcast\/?/i,            "PodcastSeries",       ["PodcastEpisode"]],
  [/\/video\/?/i,              "VideoObject",         []],
];

const SOFTWARE_TERMS = [
  "wordpress plugin", "chrome extension", "browser extension", "saas", "software as a service",
  "api", "sdk", "webhook", "dashboard", "integration", "automation", "workflow",
  "open source", "self-hosted", "cloud-based", "free trial", "sign up free",
];

const FEATURE_TERMS = [
  "features", "capabilities", "what you can do", "how it works",
  "what's included", "key benefits", "highlights", "advantages",
];

const PRICING_PATTERNS = [
  /\$\d+/, /€\d+/, /£\d+/, /per\s+month/i, /per\s+year/i, /\/mo\b/i, /\/yr\b/i,
  /free\s+plan/i, /pro\s+plan/i, /enterprise\s+plan/i, /pricing/i, /upgrade/i,
];

const FAQ_PATTERNS = [
  /frequently asked questions/i, /\bfaq\b/i, /common questions/i,
];

const REVIEW_PATTERNS = [
  /\d(\.\d+)?\s*(out of|\/)\s*5/i, /\d+\s+stars?/i, /\d+\s+reviews?/i,
  /testimonials?/i, /what\s+(our\s+)?customers?\s+say/i,
];

const HOWTO_PATTERNS = [
  /step\s+\d/i, /how\s+to\b/i, /getting\s+started/i, /quick\s+start/i,
  /\bguide\b/i, /\btutorial\b/i, /follow\s+these\s+steps/i,
];

const EVENT_PATTERNS = [
  /\bwebinar\b/i, /\bconference\b/i, /register\s+now/i, /save\s+your\s+seat/i,
  /join\s+us\s+(on|at)/i, /\blive\s+event\b/i,
];

const LOCAL_BUSINESS_PATTERNS = [
  /opening\s+hours/i, /business\s+hours/i, /we'?re\s+open/i,
  /get\s+directions/i, /find\s+us\b/i, /our\s+address/i,
];

export function classifyPage(input: NormalizedInput): PageClassification {
  const signals: string[] = [];
  const additional = new Set<string>();
  let primaryHint = "WebPage";

  const url = (input.canonicalUrl || input.sourceUrl || "").toLowerCase();
  const text = (input.text || "").toLowerCase();
  const html = (input.html || "").toLowerCase();

  // 1) URL-path rules (highest confidence)
  for (const [pattern, primary, extras] of URL_RULES) {
    if (pattern.test(url)) {
      primaryHint = primary;
      extras.forEach((t) => additional.add(t));
      signals.push(`url:${pattern.source}`);
      break;
    }
  }

  // 2) og:type meta tag
  const ogTypeMatch = html.match(/property="og:type"\s+content="([^"]+)"/);
  if (ogTypeMatch) {
    const ogType = ogTypeMatch[1];
    if (ogType === "article") {
      if (primaryHint === "WebPage") primaryHint = "Article";
      additional.add("Article");
      signals.push("og:type=article");
    } else if (ogType === "product") {
      if (primaryHint === "WebPage") primaryHint = "Product";
      additional.add("Product");
      signals.push("og:type=product");
    }
  }

  // 3) Software signals
  if (SOFTWARE_TERMS.some((t) => text.includes(t))) {
    if (primaryHint === "WebPage") primaryHint = "SoftwareApplication";
    additional.add("SoftwareApplication");
    signals.push("software-terminology");
  }

  // 4) Feature list signals
  if (FEATURE_TERMS.some((t) => text.includes(t))) {
    additional.add("ItemList");
    signals.push("feature-list-content");
  }

  // 5) Pricing signals
  if (PRICING_PATTERNS.some((p) => p.test(text))) {
    additional.add("Offer");
    additional.add("AggregateOffer");
    additional.add("PriceSpecification");
    signals.push("pricing-signals");
  }

  // 6) FAQ signals
  if (FAQ_PATTERNS.some((p) => p.test(text)) || html.includes('itemtype="https://schema.org/faqpage"')) {
    additional.add("FAQPage");
    additional.add("Question");
    signals.push("faq-content");
  }

  // 7) HowTo signals
  if (HOWTO_PATTERNS.some((p) => p.test(text))) {
    additional.add("HowTo");
    additional.add("HowToStep");
    signals.push("howto-content");
  }

  // 8) Review / rating signals
  if (REVIEW_PATTERNS.some((p) => p.test(text))) {
    additional.add("Review");
    additional.add("AggregateRating");
    signals.push("review-signals");
  }

  // 9) Event signals
  if (EVENT_PATTERNS.some((p) => p.test(text))) {
    additional.add("Event");
    additional.add("OnlineEvent");
    signals.push("event-signals");
  }

  // 10) Local business signals
  if (LOCAL_BUSINESS_PATTERNS.some((p) => p.test(text))) {
    additional.add("LocalBusiness");
    signals.push("local-business-signals");
  }

  // 11) Article/blog signals from HTML structure
  if (/<article[\s>]/i.test(html) || html.includes('class="post') || html.includes("class='post")) {
    additional.add("BlogPosting");
    additional.add("Article");
    signals.push("article-html-structure");
  }

  // 12) Video signals
  if (html.includes("<video") || html.includes("youtube.com/embed") || html.includes("vimeo.com/video")) {
    additional.add("VideoObject");
    signals.push("video-embed");
  }

  return {
    primaryHint,
    additionalHints: [...additional],
    signals,
  };
}
