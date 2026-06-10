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
  // Software / SaaS
  [/\/features?\/?(\?.*)?$/i,       "SoftwareApplication", ["ItemList"]],
  [/\/pricing\/?(\?.*)?$/i,         "SoftwareApplication", ["Offer", "AggregateOffer", "PriceSpecification"]],
  [/\/plans?\/?(\?.*)?$/i,          "SoftwareApplication", ["Offer", "AggregateOffer"]],
  [/\/download\/?(\?.*)?$/i,        "SoftwareApplication", []],
  [/\/integrations?\/?/i,           "SoftwareApplication", ["ItemList"]],
  [/\/changelog\/?/i,               "SoftwareApplication", ["TechArticle"]],
  [/\/release-?notes?\/?/i,         "SoftwareApplication", ["TechArticle"]],
  [/\/docs?\/?/i,                   "TechArticle",          ["HowTo", "SoftwareApplication"]],
  [/\/api[-\/]/i,                   "TechArticle",          ["SoftwareApplication"]],
  [/\/tutorial\/?/i,                "HowTo",                ["TechArticle"]],
  [/\/how-to\/?/i,                  "HowTo",                []],
  [/\/guide\/?/i,                   "HowTo",                ["TechArticle"]],
  // E-commerce
  [/\/product\//i,                  "Product",              ["Offer"]],
  [/\/products?\/?$/i,              "Product",              ["Offer", "ItemList"]],
  [/\/shop\/?/i,                    "Product",              ["Offer", "ItemList"]],
  [/\/store\/?/i,                   "Product",              ["Offer", "ItemList"]],
  [/\/collection\//i,               "Product",              ["ItemList"]],
  [/\/category\//i,                 "Product",              ["ItemList"]],
  [/\/cart\/?(\?.*)?$/i,            "Offer",                []],
  [/\/checkout\/?/i,                "Offer",                []],
  // Food & restaurants
  [/\/menu\/?/i,                    "Restaurant",           ["FoodEstablishment", "Menu"]],
  [/\/speisekarte\/?/i,             "Restaurant",           ["FoodEstablishment", "Menu"]],
  [/\/recipes?\//i,                 "Recipe",               []],
  [/\/rezept\//i,                   "Recipe",               []],
  // Hotels & lodging
  [/\/rooms?\/?/i,                  "Hotel",                ["LodgingBusiness", "Accommodation"]],
  [/\/zimmer\/?/i,                  "Hotel",                ["LodgingBusiness", "Accommodation"]],
  [/\/accommodation\/?/i,           "LodgingBusiness",      ["Accommodation"]],
  [/\/booking\/?/i,                 "LodgingBusiness",      ["Offer"]],
  // Real estate
  [/\/immobili/i,                   "RealEstateAgent",      ["RealEstateListing"]],
  [/\/property\//i,                 "RealEstateListing",    []],
  [/\/for-(?:sale|rent)\/?/i,       "RealEstateListing",    ["Offer"]],
  // Medical / healthcare
  [/\/medical\//i,                  "MedicalClinic",        []],
  [/\/arzt\//i,                     "Physician",            ["MedicalClinic"]],
  [/\/praxis\/?/i,                  "Physician",            ["MedicalClinic"]],
  [/\/pharmacy\/?/i,                "Pharmacy",             []],
  [/\/apotheke\/?/i,                "Pharmacy",             []],
  // Education
  [/\/course\/?/i,                  "Course",               ["EducationEvent"]],
  [/\/kurs\/?/i,                    "Course",               ["EducationEvent"]],
  [/\/lessons?\/?/i,                "Course",               ["HowTo"]],
  [/\/certif(ication|ikat)\/?/i,    "EducationalOccupationalCredential", ["Course"]],
  // Jobs
  [/\/jobs?\/?/i,                   "JobPosting",           []],
  [/\/careers?\/?/i,                "JobPosting",           ["Organization"]],
  [/\/stellenanzeig/i,              "JobPosting",           []],
  [/\/stellenangebot/i,             "JobPosting",           []],
  // Content
  [/\/(blog|posts?)\//i,            "BlogPosting",          ["Article"]],
  [/\/news\//i,                     "NewsArticle",          ["Article"]],
  [/\/press\//i,                    "NewsArticle",          ["Article"]],
  [/\/artikel\//i,                  "Article",              ["BlogPosting"]],
  [/\/podcast\//i,                  "PodcastSeries",        ["PodcastEpisode"]],
  [/\/episode\//i,                  "PodcastEpisode",       ["PodcastSeries"]],
  [/\/video\//i,                    "VideoObject",          []],
  // Events
  [/\/events?\//i,                  "Event",                []],
  [/\/webinar\/?/i,                 "OnlineEvent",          ["Event"]],
  [/\/veranstaltung\//i,            "Event",                []],
  [/\/konzert\//i,                  "MusicEvent",           ["Event"]],
  [/\/concert\//i,                  "MusicEvent",           ["Event"]],
  [/\/ausstellung\//i,              "ExhibitionEvent",      ["Event"]],
  // Places & churches
  [/\/kirche\/?/i,                  "Church",               ["PlaceOfWorship"]],
  [/\/church\/?/i,                  "Church",               ["PlaceOfWorship"]],
  [/\/kloster\/?/i,                 "Monastery",            ["PlaceOfWorship"]],
  [/\/museum\/?/i,                  "Museum",               ["TouristAttraction"]],
  [/\/park\/?/i,                    "Park",                 ["TouristAttraction"]],
  // People & profiles
  [/\/author\//i,                   "Person",               []],
  [/\/profile\//i,                  "Person",               []],
  [/\/team\/?(\?.*)?$/i,            "AboutPage",            ["Person"]],
  [/\/about\/?(\?.*)?$/i,           "AboutPage",            ["Organization", "Person"]],
  // Contact
  [/\/contact\/?(\?.*)?$/i,         "ContactPage",          ["LocalBusiness", "Organization"]],
  [/\/kontakt\/?(\?.*)?$/i,         "ContactPage",          ["LocalBusiness", "Organization"]],
  // FAQ
  [/\/faq\/?(\?.*)?$/i,             "FAQPage",              ["Question"]],
  // Review
  [/\/review\//i,                   "Review",               ["AggregateRating"]],
  // Legal
  [/\/privacy\/?(\?.*)?$/i,         "WebPage",              []],
  [/\/impress?um?\/?(\?.*)?$/i,     "AboutPage",            ["Organization"]],
];

const SOFTWARE_TERMS = [
  "wordpress plugin", "chrome extension", "browser extension", "saas", "software as a service",
  "api", "sdk", "webhook", "dashboard", "integration", "automation", "workflow",
  "open source", "self-hosted", "cloud-based", "free trial", "sign up free",
  "command line", "cli ", "npm install", "pip install", "yarn add",
];

const FEATURE_TERMS = [
  "features", "capabilities", "what you can do", "how it works",
  "what's included", "key benefits", "highlights", "advantages",
  "funktionen", "vorteile", "leistungen",
];

const PRICING_PATTERNS = [
  /\$\d+/, /€\d+/, /£\d+/, /¥\d+/, /per\s+month/i, /per\s+year/i, /\/mo\b/i, /\/yr\b/i,
  /free\s+plan/i, /pro\s+plan/i, /enterprise\s+plan/i, /business\s+plan/i,
  /pricing/i, /upgrade/i, /\bab\s+€?\d+/i, /kostenlos/i, /\bpreise\b/i,
  /monatlich/i, /jährlich/i,
];

const FAQ_PATTERNS = [
  /frequently asked questions/i, /\bfaq\b/i, /common questions/i,
  /häufig(e|en|ste)?\s+fragen/i, /\bhäufige\s+fragen/i,
];

const REVIEW_PATTERNS = [
  /\d(\.\d+)?\s*(out of|\/)\s*5/i, /\d+\s+stars?/i, /\d+\s+reviews?/i,
  /testimonials?/i, /what\s+(our\s+)?customers?\s+say/i,
  /kundenbewertung/i, /\bbewertungen?\b/i, /\brezension/i,
];

const HOWTO_PATTERNS = [
  /step\s+\d/i, /how\s+to\b/i, /getting\s+started/i, /quick\s+start/i,
  /\bguide\b/i, /\btutorial\b/i, /follow\s+these\s+steps/i,
  /schritt\s+\d/i, /so\s+geht\s+(es|das)/i, /anleitung/i,
];

const EVENT_PATTERNS = [
  /\bwebinar\b/i, /\bconference\b/i, /register\s+now/i, /save\s+your\s+seat/i,
  /join\s+us\s+(on|at)/i, /\blive\s+event\b/i,
  /\bveranstaltung\b/i, /\bkonzert\b/i, /\bausstellung\b/i,
  /\bmesse\b/i, /\bjetzt\s+anmelden\b/i, /\btickets?\s+kaufen/i,
];

const LOCAL_BUSINESS_PATTERNS = [
  /opening\s+hours/i, /business\s+hours/i, /we'?re\s+open/i,
  /get\s+directions/i, /find\s+us\b/i, /our\s+address/i,
  /öffnungszeiten/i, /\banfahrt\b/i, /\bunsere\s+adresse\b/i, /\bkontaktformular\b/i,
  /\bsprechzeiten\b/i, /\btermin\s+vereinbaren\b/i,
];

const RESTAURANT_PATTERNS = [
  /\brestaurant\b/i, /\bcafe\b/i, /\bcafé\b/i, /\bbistro\b/i, /\bpizzeria\b/i,
  /\bbäckerei\b/i, /\bbakery\b/i, /\bpastry\b/i, /\bimbiss\b/i,
  /\bspeisekarte\b/i, /\bmenu\b/i, /\bgerichte\b/i, /\bküche\b/i,
  /\bfrühstück\b/i, /\bmittagstisch\b/i, /\babendessen\b/i,
  /serves?\s+cuisine/i, /\bvegan\b/i, /\bvegetarian\b/i, /\bgluten.free\b/i,
  /\breservierung\b/i, /\breservation\b/i,
];

const HOTEL_PATTERNS = [
  /\bhotel\b/i, /\bpension\b/i, /\bgasthof\b/i, /\bgasthaus\b/i,
  /\bhostel\b/i, /\bb&b\b/i, /\bbed\s+and\s+breakfast\b/i,
  /\bferienwohnung\b/i, /\bferienhau/i, /\bvacation\s+rental\b/i, /\bapartment\b/i,
  /\bzimmer\s+buchen\b/i, /\bcheckin\b/i, /\bcheck.in\b/i, /\bcheck.out\b/i,
  /\bübernacht/i, /\bnachtruhe\b/i,
];

const MEDICAL_PATTERNS = [
  /\bdr\.\s+med\b/i, /\bpraxis\b/i, /\bfacharzt\b/i, /\bhausarzt\b/i,
  /\bdentist\b/i, /\bzahnarzt\b/i, /\bklinik\b/i, /\bkrankenhaus\b/i,
  /\bhospital\b/i, /\bpharmacy\b/i, /\bapotheke\b/i,
  /\btherapie\b/i, /\bbehandlung\b/i, /\bsprechstunde\b/i,
  /medical\s+practice/i, /general\s+practitioner/i,
];

const REAL_ESTATE_PATTERNS = [
  /\bimmobilien\b/i, /\bimmobilie\b/i, /\bwohnung\s+kaufen\b/i,
  /\haus\s+kaufen\b/i, /\bhaus\s+mieten\b/i, /\bwohnung\s+mieten\b/i,
  /\breal\s+estate\b/i, /\bproperty\s+for\s+(sale|rent)\b/i,
  /\bquadratmeter\b/i, /\b\d+\s*m²\b/, /\bkaltmiete\b/i, /\bkaufpreis\b/i,
  /\bgrundstück\b/i, /\bretail\s+space\b/i,
];

const JOB_PATTERNS = [
  /\bjob\b/i, /\bcareer\b/i, /\bvacancy\b/i, /\bposition\b/i, /\bapply\s+now\b/i,
  /\bstelle\b/i, /\bstellenanzeige\b/i, /\bstelle\s+zu\s+besetzen\b/i,
  /\bbewerbung\b/i, /\bbewerben\b/i, /\bgesucht\b/i, /\bjetzt\s+bewerben\b/i,
  /\bm\/w\/d\b/i, /\bvollzeit\b/i, /\bteilzeit\b/i, /\bgehalt\b/i,
  /\bfull.?time\b/i, /\bpart.?time\b/i, /\bremote\s+job\b/i,
];

const PLACE_OF_WORSHIP_PATTERNS = [
  // English
  /\bchurch\b/i, /\bcathedral\b/i, /\bchapel\b/i, /\bbasilica\b/i,
  /\babbey\b/i, /\bmonastery\b/i, /\bmosque\b/i, /\bsynagogue\b/i, /\btemple\b/i,
  // German
  /\bkirche\b/i, /\bbasilika\b/i, /\bdom\b(?!\s*ain)/i, /\bkloster\b/i, /\babtei\b/i,
  /\bgottesdienst/i, /\bpfarrei\b/i, /\bpfarrkirche\b/i,
];

const TOURIST_ATTRACTION_PATTERNS = [
  /historisch/i, /\bjahrhundert\b/i, /\bdenkmal\b/i, /\bmonument\b/i,
  /\bheritage\b/i, /\bunesco\b/i, /\bwelterbe\b/i, /\bsehenswürdigkeit/i,
  /tourist\s+attract/i, /\barchitekt(ur)?\b/i,
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
    if (primaryHint === "WebPage") primaryHint = "LocalBusiness";
    additional.add("LocalBusiness");
    signals.push("local-business-signals");
  }

  // 11) Place of worship / religious site (English + German)
  if (PLACE_OF_WORSHIP_PATTERNS.some((p) => p.test(text) || p.test(url))) {
    if (primaryHint === "WebPage" || primaryHint === "LocalBusiness") primaryHint = "Church";
    additional.add("Church");
    additional.add("PlaceOfWorship");
    additional.add("CivicStructure");
    additional.add("LocalBusiness");
    signals.push("place-of-worship");
  }

  // 12) Tourist attraction / historical landmark
  if (TOURIST_ATTRACTION_PATTERNS.some((p) => p.test(text))) {
    additional.add("TouristAttraction");
    additional.add("LandmarksOrHistoricalBuildings");
    signals.push("tourist-attraction");
  }

  // 13) German postal code → address present → local business likely
  if (/\b\d{5}[\s ]?[A-ZÄÖÜ]/i.test(text)) {
    if (primaryHint === "WebPage") primaryHint = "LocalBusiness";
    additional.add("LocalBusiness");
    additional.add("PostalAddress");
    signals.push("postal-address-de");
  }

  // 14) Restaurant / food service
  if (RESTAURANT_PATTERNS.some((p) => p.test(text) || p.test(url))) {
    if (primaryHint === "WebPage" || primaryHint === "LocalBusiness") primaryHint = "Restaurant";
    additional.add("Restaurant");
    additional.add("FoodEstablishment");
    additional.add("LocalBusiness");
    signals.push("restaurant-signals");
  }

  // 15) Hotel / lodging
  if (HOTEL_PATTERNS.some((p) => p.test(text) || p.test(url))) {
    if (primaryHint === "WebPage" || primaryHint === "LocalBusiness") primaryHint = "Hotel";
    additional.add("Hotel");
    additional.add("LodgingBusiness");
    additional.add("LocalBusiness");
    signals.push("hotel-signals");
  }

  // 16) Medical / healthcare
  if (MEDICAL_PATTERNS.some((p) => p.test(text) || p.test(url))) {
    if (primaryHint === "WebPage" || primaryHint === "LocalBusiness") primaryHint = "MedicalClinic";
    additional.add("MedicalClinic");
    additional.add("LocalBusiness");
    signals.push("medical-signals");
  }

  // 17) Real estate
  if (REAL_ESTATE_PATTERNS.some((p) => p.test(text) || p.test(url))) {
    if (primaryHint === "WebPage") primaryHint = "RealEstateListing";
    additional.add("RealEstateListing");
    additional.add("RealEstateAgent");
    signals.push("real-estate-signals");
  }

  // 18) Job posting
  if (JOB_PATTERNS.some((p) => p.test(text) || p.test(url))) {
    if (primaryHint === "WebPage") primaryHint = "JobPosting";
    additional.add("JobPosting");
    signals.push("job-posting-signals");
  }

  // 19) Article/blog signals from HTML structure
  if (/<article[\s>]/i.test(html) || html.includes('class="post') || html.includes("class='post")) {
    additional.add("BlogPosting");
    additional.add("Article");
    signals.push("article-html-structure");
  }

  // 20) Video signals
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
