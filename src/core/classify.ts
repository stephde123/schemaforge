import type { NormalizedInput } from "./types.js";

export interface PageClassification {
  primaryHint: string;
  additionalHints: string[];
  signals: string[];
  /** 0–1: how confident we are about primaryHint. */
  confidence: number;
}

/**
 * URL-path rules: [pattern, primaryType, additionalTypes]
 * All matching rules now vote (evidence-scoring); first-match is no longer a hard break.
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
  [/\/author\//i,                   "Person",               ["ProfilePage"]],
  [/\/profile\//i,                  "Person",               ["ProfilePage"]],
  [/\/team\/?(\?.*)?$/i,            "AboutPage",            ["Person"]],
  [/\/about\/?(\?.*)?$/i,           "AboutPage",            ["Organization", "Person"]],
  [/[-\/]about-me(\/|$)/i,          "ProfilePage",          ["Person"]],
  [/[-\/]ueber-mich(\/|$)/i,        "ProfilePage",          ["Person"]],
  [/\/%C3%BCber-mich/i,             "ProfilePage",          ["Person"]],
  [/[-\/]about-us(\/|$)/i,          "AboutPage",            ["Organization", "Person"]],
  [/[-\/]über-mich(\/|$)/i,         "ProfilePage",          ["Person"]],
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

const PERSON_PROFILE_PATTERNS = [
  /\babout\s+me\b/i, /\bmy\s+story\b/i, /\bbiograph(y|ie)\b/i,
  /über\s+mich/i, /ueber\s+mich/i, /\bmeine\s+geschichte\b/i,
  /\bmein\s+weg\b/i, /\bwer\s+bin\s+ich\b/i, /\bich\s+bin\s+\w/i,
  /\bpersonal\s+trainer\b/i, /\blife\s+coach\b/i, /\bfreelancer\b/i,
  /\bspeaker\b/i, /\bcoach\b/i, /\bberater(in)?\b/i, /\btrainer(in)?\b/i,
  /\bphotograph(er|in)\b/i, /\bdesigner(in)?\b/i, /\bfreelance\b/i,
  /\btherapist\b/i, /\btherapeutin?\b/i,
  /\bpersonal\s+coach\b/i, /\bernährungscoach\b/i, /\bmotivationscoach\b/i,
  /\blizenzierter?\s+trainer\b/i,
];

const TOURIST_ATTRACTION_PATTERNS = [
  /historisch/i, /\bjahrhundert\b/i, /\bdenkmal\b/i, /\bmonument\b/i,
  /\bheritage\b/i, /\bunesco\b/i, /\bwelterbe\b/i, /\bsehenswürdigkeit/i,
  /tourist\s+attract/i, /\barchitekt(ur)?\b/i,
];

// ---------------------------------------------------------------------------
// Evidence-scoring engine
// ---------------------------------------------------------------------------

/**
 * Types that are always additive/subordinate and must not become the primary
 * classification hint, even if they accumulate the highest score.
 */
const NON_PRIMARY = new Set([
  "Offer", "AggregateOffer", "PriceSpecification",
  "AggregateRating", "Review",
  "ItemList", "HowToStep", "BreadcrumbList", "PostalAddress",
  "Question", "Answer",
  "PlaceOfWorship", "CivicStructure",
  "FoodEstablishment", "LodgingBusiness",
  "TouristAttraction", "LandmarksOrHistoricalBuildings",
  "RealEstateAgent",
]);

export function classifyPage(input: NormalizedInput): PageClassification {
  const scores = new Map<string, number>();
  const signals: string[] = [];

  const addSignal = (s: string) => { if (!signals.includes(s)) signals.push(s); };
  const v = (type: string, score: number) => scores.set(type, (scores.get(type) ?? 0) + score);

  const url  = (input.canonicalUrl || input.sourceUrl || "").toLowerCase();
  const text = (input.text || "").toLowerCase();
  const html = (input.html || "").toLowerCase();
  const sig  = input.wpSignals;

  // --- Tier 1: authoritative wpSignals (60–80 pts) ---
  if (sig?.events?.startDate) {
    v("Event", 80); addSignal("wpsig:events");
  }
  if (sig?.jobs && (sig.jobs.company || sig.jobs.location || sig.jobs.jobType)) {
    v("JobPosting", 80); addSignal("wpsig:jobs");
  }
  if (sig?.courses) {
    v("Course", 80); addSignal("wpsig:courses");
  }
  if (sig?.edd) {
    v("SoftwareApplication", 70); addSignal("wpsig:edd");
  }
  if (sig?.woocommerce) {
    v("Product", 65); addSignal("wpsig:woocommerce");
  }
  const postType = sig?.post?.type;
  if (postType === "product")                                                    { v("Product", 60);              addSignal("wpsig:post_type=product"); }
  else if (postType === "tribe_events")                                          { v("Event", 70);                addSignal("wpsig:post_type=tribe_events"); }
  else if (postType === "job_listing")                                           { v("JobPosting", 70);           addSignal("wpsig:post_type=job_listing"); }
  else if (postType === "download")                                              { v("SoftwareApplication", 60); addSignal("wpsig:post_type=download"); }
  else if (["lp_course","tutor-course","tutor_course","course"].includes(postType ?? "")) {
    v("Course", 70); addSignal("wpsig:post_type=course");
  }
  else if (postType === "post")                                                  { v("BlogPosting", 30);          addSignal("wpsig:post_type=post"); }

  if (sig?.blocks?.some(b => (b.faqItems?.length ?? 0) >= 2)) {
    v("FAQPage", 40); addSignal("wpsig:faq_blocks");
  }
  if (sig?.ratings?.average != null) {
    v("AggregateRating", 30); addSignal("wpsig:ratings");
  }

  // --- Tier 2: URL-path rules (45 pts each; all matching rules vote) ---
  for (const [pattern, primary, extras] of URL_RULES) {
    if (pattern.test(url)) {
      v(primary, 45); addSignal(`url:${pattern.source}`);
      for (const extra of extras) v(extra, 15);
    }
  }

  // --- Tier 3: HTML meta signals ---
  const ogTypeMatch = html.match(/property="og:type"\s+content="([^"]+)"/);
  if (ogTypeMatch) {
    if (ogTypeMatch[1] === "article") { v("Article", 35); addSignal("og:type=article"); }
    if (ogTypeMatch[1] === "product") { v("Product", 35); addSignal("og:type=product"); }
  }
  if (html.includes('itemtype="https://schema.org/faqpage"')) {
    v("FAQPage", 30); addSignal("microdata:FAQPage");
  }

  // --- Tier 4: text/HTML content signals ---
  if (SOFTWARE_TERMS.some(t => text.includes(t)))                             { v("SoftwareApplication", 25); addSignal("software-terminology"); }
  if (FEATURE_TERMS.some(t => text.includes(t)))                              { v("ItemList", 10);             addSignal("feature-list-content"); }
  if (PRICING_PATTERNS.some(p => p.test(text))) {
    v("Offer", 10); v("AggregateOffer", 5); v("PriceSpecification", 5); addSignal("pricing-signals");
  }
  if (FAQ_PATTERNS.some(p => p.test(text)))                                   { v("FAQPage", 20);              addSignal("faq-content"); }
  if (HOWTO_PATTERNS.some(p => p.test(text)))                                 { v("HowTo", 20);                addSignal("howto-content"); }
  if (REVIEW_PATTERNS.some(p => p.test(text)))                                { v("AggregateRating", 10); v("Review", 10); addSignal("review-signals"); }
  if (EVENT_PATTERNS.some(p => p.test(text)))                                 { v("Event", 25);                addSignal("event-signals"); }
  if (LOCAL_BUSINESS_PATTERNS.some(p => p.test(text)))                        { v("LocalBusiness", 25);        addSignal("local-business-signals"); }
  if (PLACE_OF_WORSHIP_PATTERNS.some(p => p.test(text) || p.test(url))) {
    v("Church", 45); v("PlaceOfWorship", 20); v("CivicStructure", 10); v("LocalBusiness", 15);
    addSignal("place-of-worship");
  }
  if (TOURIST_ATTRACTION_PATTERNS.some(p => p.test(text))) {
    v("TouristAttraction", 20); v("LandmarksOrHistoricalBuildings", 15); addSignal("tourist-attraction");
  }
  if (/\b\d{5}[\s ]?[A-ZÄÖÜ]/i.test(text))                                   { v("LocalBusiness", 20);        addSignal("postal-address-de"); }
  if (RESTAURANT_PATTERNS.some(p => p.test(text) || p.test(url))) {
    v("Restaurant", 40); v("FoodEstablishment", 15); v("LocalBusiness", 10); addSignal("restaurant-signals");
  }
  if (HOTEL_PATTERNS.some(p => p.test(text) || p.test(url))) {
    v("Hotel", 40); v("LodgingBusiness", 15); v("LocalBusiness", 10); addSignal("hotel-signals");
  }
  if (MEDICAL_PATTERNS.some(p => p.test(text) || p.test(url))) {
    v("MedicalClinic", 35); v("LocalBusiness", 10); addSignal("medical-signals");
  }
  if (REAL_ESTATE_PATTERNS.some(p => p.test(text) || p.test(url))) {
    v("RealEstateListing", 30); v("RealEstateAgent", 10); addSignal("real-estate-signals");
  }
  if (JOB_PATTERNS.some(p => p.test(text) || p.test(url)))                   { v("JobPosting", 30);           addSignal("job-posting-signals"); }
  if (PERSON_PROFILE_PATTERNS.some(p => p.test(text) || p.test(url))) {
    v("ProfilePage", 30); v("Person", 15); addSignal("person-profile-signals");
  }
  if (/<article[\s>]/i.test(html) || html.includes('class="post') || html.includes("class='post")) {
    v("BlogPosting", 15); addSignal("article-html-structure");
  }
  if (html.includes("<video") || html.includes("youtube.com/embed") || html.includes("vimeo.com/video")) {
    v("VideoObject", 15); addSignal("video-embed");
  }

  // --- Resolve primaryHint: highest-scoring non-additive type wins ---
  let primaryHint = "WebPage";
  let topScore = 0;

  for (const [type, score] of scores) {
    if (!NON_PRIMARY.has(type) && score > topScore) {
      topScore = score;
      primaryHint = type;
    }
  }

  // Collect additional hints: all types with any score except primary
  const additional = new Set<string>();
  for (const [type] of scores) {
    if (type !== primaryHint) additional.add(type);
  }

  return {
    primaryHint,
    additionalHints: [...additional],
    signals,
    confidence: scoreToConfidence(topScore, primaryHint),
  };
}

function scoreToConfidence(score: number, primaryHint: string): number {
  if (primaryHint === "WebPage" || score === 0) return 0.20;
  if (score < 45) return 0.20 + score * 0.005;
  // Linear ramp: 45 → 0.45, ~200 → 0.95, capped at 0.95
  return Math.min(0.45 + (score - 45) / 200, 0.95);
}
