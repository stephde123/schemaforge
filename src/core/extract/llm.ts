import type { Entity, NormalizedInput, RequestContext } from "../types.js";
import type { SchemaBrain } from "../schema-brain.js";
import type { LlmProvider } from "../llm/provider.js";
import type { PageClassification } from "../classify.js";

export async function llmExtract(
  input: NormalizedInput,
  base: Entity[],
  brain: SchemaBrain,
  llm: LlmProvider,
  classification?: PageClassification,
  requestContext?: RequestContext,
): Promise<Entity[]> {
  const candidateTypes = pickCandidateTypes(base, brain, classification);
  const propertyHints = buildPropertyHints(candidateTypes, brain, classification, base);

  const raw = await llm.complete(SYSTEM_PROMPT, buildUserPrompt(input, base, candidateTypes, propertyHints, classification, requestContext));
  const parsed = safeParse(raw);
  if (!parsed) return [];

  const nodes = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any).entities)
      ? (parsed as any).entities
      : Array.isArray((parsed as any)["@graph"])
        ? (parsed as any)["@graph"]
        : [];

  return nodes
    .filter((n: any) => n && n["@type"])
    .map((n: any): Entity => {
      const { "@type": type, "@id": id, sameAs: _sameAs, ...rest } = n;
      return {
        id: typeof id === "string" ? id : undefined,
        type,
        props: rest,
        _source: "llm",
      };
    });
}

const SYSTEM_PROMPT = `You are a world-class schema.org structured-data engineer.
Your mission: produce the MOST COMPREHENSIVE, SPECIFIC, and ACCURATE set of schema.org entities possible for the given web page. Aim well beyond the minimum Google rich-result fields — if a fact is on the page and a schema.org property exists for it, mark it up.

## Depth & completeness (this is the whole point)
- Emit EVERY distinct entity the page supports, not just the primary one: the primary content entity, its author/publisher/provider, the site (WebSite), the organization behind it, images (ImageObject), breadcrumbs, ratings, offers, the subject(s) the content is about, sub-parts (sections, steps, list items, Q&As, menu sections, room types, course instances, episodes…).
- Fill EVERY valid property for which the page gives a value. A node with 4 properties when the page supports 15 is a failure.
- Prefer linked sub-entities over bare strings: author → Person node; address → PostalAddress; opening hours → OpeningHoursSpecification[]; price → Offer with priceCurrency; ratings → AggregateRating; geo → GeoCoordinates; measurements → QuantitativeValue.
- Cross-cutting properties to always consider when the page supports them: about / mentions (link content to the entities it discusses), mainEntity, isPartOf / hasPart, datePublished / dateModified, inLanguage, keywords, author / publisher / copyrightHolder / creator / provider, image / primaryImageOfPage / thumbnailUrl, url, description, alternateName, identifier, sameAs (ONLY from links literally on the page — see rules), wordCount / timeRequired / totalTime, audience, accessibilityFeature, significantLink / relatedLink, potentialAction, speakable (SpeakableSpecification), citation, isBasedOn, license, contentRating, award, knowsAbout / knowsLanguage (Person), areaServed / serviceType / slogan / foundingDate / numberOfEmployees (Organization).
- Include parallel types that add real structured-data value (a historic church → CatholicChurch + TouristAttraction + LandmarksOrHistoricalBuildings; an API doc → TechArticle + WebAPI).

## Core rules
- Choose the MOST SPECIFIC subtype available (e.g. Dentist over LocalBusiness, SoftwareApplication over WebPage for a software features page). BUT: an informational page — a glossary entry, a blog post, a guide, a definition — stays an Article/BlogPosting/TechArticle even when it discusses, mentions, or is published by a software product. Only type a page as SoftwareApplication/Product when the page's own subject *is* that product (its features, pricing, download). To connect an article to a product it is about, add "about" or "mentions" on the Article pointing at the product entity — do not re-type the article.
- Emit MULTIPLE entities when the page contains multiple distinct concepts (e.g. a software features page may need: SoftwareApplication + ItemList of features + Organization + WebPage).
- Only use properties listed in validPropertiesPerType. Do NOT invent property names.
- STRICT EXTRACTION ONLY: every value you emit must be explicitly present in the page content. Do NOT generate, guess, or infer URLs, email addresses, phone numbers, social media handles, identifiers, or any other data that is not literally written on the page. If a piece of information is not on the page, omit the property entirely.
- Do NOT emit sameAs under any circumstances — not for people, organizations, places, or any other entity type.
- Link entities by "@id" reference rather than deep nesting when the target entity is already in the graph.
- "@id" convention: for a node you create that is a PART of this page (the article, a section, a list, a HowTo, a sub-entity) use a fragment id: "<pageURL>#article", "<pageURL>#howto-embedding", "<pageURL>#feature-list". Use a bare URL as an "@id" ONLY for an entity whose own canonical page IS that URL (that entity also has "url" set to the same value). Never give a page-part the bare page URL as its "@id" — that belongs to the WebPage node.
- Output STRICT JSON: {"entities": [...]} where each element has "@type" plus properties. No markdown, no prose.

## Do not duplicate the existing graph (baseGraph)
The baseGraph already exists on the page. Your job is to REFINE and EXTEND it, not restate it.
- To change or enrich a baseGraph node (e.g. upgrade Article → TechArticle, add a missing property), emit a node with the SAME "@id" and ONLY the changed/added properties. The graph merger combines them.
- Do NOT emit a second node for something the baseGraph already covers under a related type. There is exactly ONE page node: if the baseGraph WebPage is already typed FAQPage with mainEntity, do not emit another FAQPage — add to the existing "@id" if anything is missing. Likewise there is ONE article node.
- Every "@id" you reference MUST be a node you also emit or one already present in the baseGraph. Never reference an "@id" that does not exist — e.g. do not point author at an author-archive URL; reference the actual Person node's "@id" (which may differ from that Person's url).
- A reference is { "@id": "…" } and nothing else. NEVER attach a "@type" to an "@id" that belongs to a different kind of node (pointing "about" at "#organization" but typing it SoftwareApplication corrupts that node). If you want to link to a product, EMIT a top-level SoftwareApplication/Product node with its own distinct "@id" and reference that.

## CMS signals (wpSignals — highest priority)
When a wpSignals object is present in the input, it comes directly from WordPress and is authoritative.
Prefer it over anything inferred from the page content. Do NOT omit or contradict these values:
- post.title         → primary entity name / Article.headline
- post.excerpt       → description
- post.author        → emit a Person entity (name, bio→description, url)
- post.featuredImage → ImageObject / primaryImageOfPage (url, alt→caption)
- post.publishedAt / modifiedAt → datePublished / dateModified (already ISO 8601)
- post.type          → strong schema hint ("product"→Product, "tribe_events"→Event, "job_listing"→JobPosting)
- taxonomy.categories / tags → about, keywords, or genre on the primary entity
- taxonomy.custom    → check key name for semantic meaning (e.g. "pa_color" → color attribute)
- site.name / url    → WebSite entity (name, url)
- site.logo          → Organization.logo as ImageObject
- meta.*             → scan key names for schema.org hints (e.g. "event_start_date"→startDate, "venue_name"→location.name)
- seo.description / seo.title     → prefer over body-text inferences for description/name
- blocks[].faqItems               → authoritative Q&A pairs from Gutenberg FAQ blocks; always build FAQPage from these
- blocks[].items (ordered: true)  → ordered list items; treat as HowTo steps if page context supports it
- woocommerce.sku    → Product.sku
- woocommerce.price / currency / availability → Product.offers (Offer with price, priceCurrency, availability)
- woocommerce.regularPrice / salePrice → include in priceSpecification when both are present
- woocommerce.weight / dimensions → Product.weight / hasMeasurement
- events.*           → emit Event with startDate, endDate, location (Place+PostalAddress), organizer, offers
- courses.*          → emit Course with hasCourseInstance, offers, educationalLevel, instructor (Person)
- jobs.*             → emit JobPosting with employmentType, hiringOrganization, baseSalary, jobLocation
- edd.*              → emit SoftwareApplication (or Product) with offers from price/currency; use downloadCategory for applicationCategory
- ratings.average / count → emit AggregateRating and attach it to the primary entity (Product, Course, LocalBusiness, etc.)

## What to look for per page type

### SoftwareApplication / Product pages
- Emit a SoftwareApplication (or more specific subtype like WebApplication, MobileApplication) as the primary entity.
- Populate: name, description, url, featureList (comma-separated features or array), applicationCategory, operatingSystem, offers (for pricing), screenshot, softwareVersion, releaseNotes.
- If the page lists features in sections/cards/grid → emit an ItemList whose itemListElement entries each have "@type": "ListItem", position, name, description.
- If pricing tiers exist → emit one Offer per tier with name, price, priceCurrency, description.
- If there is an AggregateRating → include ratingValue, reviewCount, bestRating.

### Article / Blog pages
- Emit Article (or BlogPosting / NewsArticle / TechArticle — whichever fits best).
- Populate: headline, description, datePublished, dateModified, author, publisher (Organization), image, url, wordCount if estimable.
- If a named person wrote it (byline, author box), emit a Person entity AND set the article's "author" to that Person's "@id" — even if the baseGraph article currently has author pointing at the Organization, override it (emit the article's "@id" with just the corrected author). Keep "publisher" as the Organization.

### FAQ pages
- Emit FAQPage with mainEntity as an array of Question objects, each with name and acceptedAnswer (Answer with text).
- Be exhaustive — capture every Q&A pair visible on the page.

### HowTo / Tutorial pages
- Emit HowTo with name, description, step (array of HowToStep with name, text, position).
- Include supply/tool if mentioned.

### Place of Worship / Religious Site / Historical Landmark pages
- Emit the MOST SPECIFIC type: CatholicChurch, BuddhistTemple, HinduTemple, Mosque, Synagogue, Church — or at minimum PlaceOfWorship.
- For famous/listed buildings also add LandmarksOrHistoricalBuildings and TouristAttraction as parallel types.
- Populate: name, alternateName, description, url, image, address (PostalAddress with streetAddress, postalCode, addressLocality, addressCountry), telephone, openingHoursSpecification or openingHours, geo (GeoCoordinates), hasMap.
- For historical buildings: include foundingDate or dateCreated if a construction era or century is mentioned (e.g. "12. Jahrhundert" → "12th century").
- Emit a separate ReligiousOrganization for the managing parish or diocese if named on the page.
- Always emit a WebSite entity when the site name / url is identifiable.

### Restaurant / Food Establishment pages
- Emit the most specific type: ItalianRestaurant, PizzaRestaurant, Bakery, BarOrPub, CafeOrCoffeeShop, FastFoodRestaurant — or FoodEstablishment if uncertain.
- Populate: name, description, url, image, address (PostalAddress), telephone, servesCuisine, menu (url or Menu entity), priceRange, openingHours, openingHoursSpecification, hasMap, acceptsReservations, aggregateRating.
- Include geo (GeoCoordinates) if lat/lng found.
- Emit a Menu entity with hasMenuSection pointing to MenuSection entities if menu sections are visible.

### Hotel / Lodging pages
- Emit the most specific type: Hotel, BedAndBreakfast, Hostel, Motel, Resort, VacationRental — or LodgingBusiness if uncertain.
- Populate: name, description, url, image, address (PostalAddress), telephone, checkInTime, checkOutTime, numberOfRooms, amenityFeature (LocationFeatureSpecification[]), starRating (Rating), priceRange, geo (GeoCoordinates), aggregateRating.
- Emit Accommodation entities for individual room types if described.

### Medical / Healthcare pages
- Emit the most specific type: Physician, Dentist, Pharmacy, Hospital, MedicalClinic, DiagnosticLab — or MedicalOrganization.
- Populate: name, description, url, image, address (PostalAddress), telephone, medicalSpecialty, openingHours, hasMap.
- Emit a Person entity for named doctors/practitioners.

### Real Estate pages
- Emit RealEstateListing for individual property listings.
- Populate: name, url, description, image, numberOfRooms, numberOfBathroomsTotal, floorSize (QuantitativeValue), geo (GeoCoordinates), address (PostalAddress), offers (Offer with price and priceCurrency).
- Emit RealEstateAgent for the agency/broker.

### Local Business pages (general)
- Emit the most specific LocalBusiness subtype available.
- Populate: name, address (PostalAddress), telephone, openingHours, geo (GeoCoordinates if lat/lng visible), priceRange, hasMap.

### Event pages
- Emit Event (or OnlineEvent / EducationEvent / etc.).
- Populate: name, startDate, endDate, location (Place or VirtualLocation), organizer, offers, eventAttendanceMode.

### Recipe pages
- Emit Recipe with: name, description, recipeIngredient, recipeInstructions (HowToStep[]), cookTime, prepTime, totalTime, recipeYield, nutrition.

### Person / Personal profile pages (Über mich, About me, coach/trainer/speaker profiles)
- Emit a Person as the primary entity.
- Populate: name, jobTitle (most specific role, e.g. "Personal Trainer", "Life Coach"), description (biography summary), url (personal website), image, address (PostalAddress with at least addressLocality and addressCountry).
- Add knowsAbout for topics of expertise (array of strings).
- Add hasCredential (EducationalOccupationalCredential) for each listed certification or degree, with credentialCategory and name.
- Add memberOf (Organization) if affiliation is mentioned.
- If the person appeared in media (TV, podcast, press), note it in description.
- Also emit a ProfilePage entity whose mainEntity references the Person by @id.
- Emit WebSite when the site name/url is identifiable.

### Organization / About pages
- Emit Organization (or more specific: Corporation, EducationalOrganization, etc.) with: name, url, logo, description, foundingDate, numberOfEmployees, address.
- Emit Person entities for founders/team members if named.

### Product / E-commerce pages
- Emit Product with: name, description, image, sku, brand (Brand/Organization), offers (Offer with price, priceCurrency, availability, url), aggregateRating.

## General guidance
- Always emit a WebSite entity when the website name/url is identifiable.
- Always include BreadcrumbList if breadcrumbs are visible.
- For any page: if there is a visible author/founder/team member → emit Person entities with at minimum name and jobTitle.
- If the page is primarily ABOUT a named individual (biography, "Über mich", "About me", personal profile, portfolio, speaker page, coach page) — regardless of the page type classification — ALWAYS emit a Person entity as the primary entity. Do not wait for a specific classification hint. Use the page text to fill name, jobTitle, description, knowsAbout, hasCredential, address.
- When an article/guide/FAQ/doc is *about* a product, org, place or person, emit that subject as its own fully-populated node and link it with about/mentions — the reader gets both the content markup and the entity markup.
- Be thorough: a low coverageScore means important entities or properties were missed. Re-scan the page for anything you left on the table before returning.`;

function buildUserPrompt(
  input: NormalizedInput,
  base: Entity[],
  candidateTypes: string[],
  propertyHints: Record<string, string[]>,
  classification?: PageClassification,
  requestContext?: RequestContext,
): string {
  return JSON.stringify(
    {
      // BINDING USER INSTRUCTION (highest priority — must be followed exactly)
      ...(input.userInstructions
        ? {
            userInstruction: `MANDATORY: The user explicitly instructed: "${input.userInstructions}". This overrides any other judgment. Follow it exactly.`,
          }
        : {}),
      // Authoritative CMS data — treat as ground truth (see SYSTEM_PROMPT for mapping rules)
      ...(input.wpSignals ? { wpSignals: input.wpSignals } : {}),
      page: {
        url: input.canonicalUrl || input.sourceUrl,
        title: input.title,
        lang: input.lang,
        // Cleaned HTML preserves heading hierarchy, lists, tables, details/summary
        // and other structural signals that plain text loses. Fall back to plain
        // text when no HTML was available (text-only input). Generous cap — a
        // truncated page means entities and properties in the tail get missed.
        content: (input.cleanedHtml ?? input.text).slice(0, 60000),
      },
      pageClassification: classification
        ? {
            primaryHint: classification.primaryHint,
            additionalHints: classification.additionalHints,
            signals: classification.signals,
          }
        : undefined,
      // Hints from the caller (e.g. WordPress plugin knows the active SEO plugin)
      callerContext: requestContext
        ? {
            detectedPlugin: requestContext.detectedPlugin,
            strategy: requestContext.strategy,
          }
        : undefined,
      baseGraph: base.map((e) => ({
        "@id": e.id,
        "@type": e.type,
        ...e.props,
      })),
      candidateTypes,
      validPropertiesPerType: propertyHints,
      instruction: input.userInstructions
        ? 'The userInstruction field contains a MANDATORY directive from the user — execute it first, then analyze the full page content and emit ALL relevant entities. Return {"entities": [...]}.'
        : 'Analyze the full page content. Emit ALL relevant entities for this page. Return {"entities": [...]} with the most specific types and ALL relevant valid properties filled in. Be comprehensive.',
    },
    null,
    2,
  );
}

/**
 * Wide base seed set covering all major schema.org use cases,
 * augmented by classification hints and existing entity types.
 */
const BASE_SEEDS = [
  // Web infrastructure
  "WebPage", "WebSite", "AboutPage", "ContactPage", "FAQPage", "CollectionPage",
  "ItemPage", "ProfilePage", "SearchResultsPage", "CheckoutPage",

  // Software & digital products
  "SoftwareApplication", "WebApplication", "MobileApplication", "VideoGame",

  // Organizations & people
  "Organization", "Corporation", "NGO", "GovernmentOrganization",
  "LocalBusiness", "Person", "Brand",

  // Local business subtypes — food & drink
  "FoodEstablishment", "Restaurant", "Bakery", "BarOrPub", "Brewery",
  "CafeOrCoffeeShop", "FastFoodRestaurant", "IceCreamShop",
  "PizzaRestaurant", "Winery", "Menu", "MenuSection", "MenuItem",

  // Local business subtypes — lodging
  "LodgingBusiness", "Hotel", "Hostel", "BedAndBreakfast", "Motel", "Resort",
  "VacationRental", "Accommodation", "Room", "Suite", "HotelRoom",
  "LocationFeatureSpecification",

  // Local business subtypes — healthcare & medical
  "MedicalOrganization", "MedicalClinic", "Physician", "Dentist",
  "DiagnosticLab", "Hospital", "Pharmacy",

  // Local business subtypes — professional services
  "AccountingService", "AutoDealer", "AutoRepair", "ChildCare",
  "FinancialService", "InsuranceAgency", "LegalService", "RealEstateAgent",
  "TravelAgency",

  // Local business subtypes — retail
  "Store", "BookStore", "ClothingStore", "ComputerStore",
  "ElectronicsStore", "FlowerShop", "FurnitureStore", "GroceryStore",
  "HardwareStore", "HomeGoodsStore", "JewelryStore",
  "LiquorStore", "PetStore", "ShoeStore", "SportingGoodsStore",
  "ToyStore",

  // Local business subtypes — personal care & fitness
  "BeautySalon", "DaySpa", "HairSalon", "NailSalon",
  "HealthClub", "GymOrFitnessCentre",

  // Local business subtypes — entertainment & arts
  "AmusementPark", "ArtGallery", "Casino", "ComedyClub", "MovieTheater",
  "MusicVenue", "NightClub", "Zoo",

  // Civic, religious & cultural places
  "CivicStructure", "PlaceOfWorship", "Church", "CatholicChurch",
  "BuddhistTemple", "HinduTemple", "Mosque", "Synagogue",
  "Monastery", "LandmarksOrHistoricalBuildings", "TouristAttraction",
  "Museum", "Park", "Cemetery", "Library", "PublicToilet",
  "Stadium", "SportsClub",

  // Organizations — religious
  "ReligiousOrganization",

  // Organizations — education
  "EducationalOrganization", "School", "HighSchool", "MiddleSchool",
  "ElementarySchool", "CollegeOrUniversity", "PreschoolEducation",

  // Products & commerce
  "Product", "ProductGroup", "IndividualProduct",
  "Offer", "AggregateOffer", "PriceSpecification",
  "RealEstateListing",

  // Content types
  "Article", "BlogPosting", "NewsArticle", "TechArticle", "Report",
  "AnalysisNewsArticle", "OpinionNewsArticle", "ReviewNewsArticle",
  "HowTo", "HowToStep", "HowToSection", "HowToTip", "HowToDirection",
  "HowToSupply", "HowToTool", "Recipe", "Guide",
  "DefinedTerm", "DefinedTermSet", "Quotation", "Claim", "SpecialAnnouncement",

  // Developer / data
  "WebAPI", "APIReference", "Dataset", "DataDownload", "SoftwareSourceCode",

  // Lists & navigation
  "ItemList", "BreadcrumbList", "ListItem",

  // Events
  "Event", "OnlineEvent", "BusinessEvent", "ChildrensEvent",
  "ComedyEvent", "CourseInstance", "DanceEvent", "DeliveryEvent",
  "EducationEvent", "ExhibitionEvent", "Festival", "FoodEvent",
  "LiteraryEvent", "MusicEvent", "PublicationEvent", "SaleEvent",
  "SocialEvent", "SportsEvent", "VisualArtsEvent",

  // Courses & credentials
  "Course", "EducationalOccupationalCredential",

  // Q&A
  "FAQPage", "QAPage", "Question", "Answer",

  // Reviews & ratings
  "Review", "AggregateRating", "Rating",

  // Jobs
  "JobPosting", "EmploymentAgency",

  // Media
  "VideoObject", "ImageObject", "AudioObject",
  "PodcastSeries", "PodcastEpisode",

  // Creative works
  "Book", "Movie", "MusicRecording", "MusicAlbum", "MusicGroup",
  "TVSeries", "TVEpisode",

  // Addresses & geo
  "Place", "PostalAddress", "GeoCoordinates", "GeoShape",

  // Other structured data
  "Person", "ContactPoint", "OpeningHoursSpecification",
  "NutritionInformation", "MonetaryAmount",
  "SpeakableSpecification",
];

function pickCandidateTypes(
  base: Entity[],
  brain: SchemaBrain,
  classification?: PageClassification,
): string[] {
  const seeds = new Set<string>(BASE_SEEDS);

  // Add any types already found in the base graph
  for (const e of base) {
    for (const t of Array.isArray(e.type) ? e.type : [e.type]) seeds.add(t);
  }

  // Add classification hints — highest priority, put in front
  if (classification) {
    seeds.add(classification.primaryHint);
    for (const h of classification.additionalHints) seeds.add(h);
  }

  // Expand the classification hints AND the base-graph types to their subtypes
  // so the LLM has the specific variants on hand (SoftwareApplication →
  // WebApplication/MobileApplication; Article → TechArticle/…). Not all
  // BASE_SEEDS — that generates ~2000 types and blows the token budget.
  if (brain.loaded) {
    const toExpand = new Set<string>();
    if (classification) {
      toExpand.add(classification.primaryHint);
      for (const h of classification.additionalHints) toExpand.add(h);
    }
    for (const e of base) {
      for (const t of Array.isArray(e.type) ? e.type : [e.type]) toExpand.add(t);
    }
    for (const hint of toExpand) {
      for (const sub of brain.subTypesOf(hint).slice(0, 25)) seeds.add(sub);
    }
  }

  // Put classification primary hint and additional hints first so the LLM
  // sees the most relevant types at the top of the list
  const prioritized: string[] = [];
  if (classification) {
    prioritized.push(classification.primaryHint);
    prioritized.push(...classification.additionalHints);
  }
  const rest = [...seeds].filter((t) => !prioritized.includes(t));
  return [...new Set([...prioritized, ...rest])];
}

// Always-useful structural types that get property hints regardless of classification
const ALWAYS_HINT_TYPES = new Set([
  "WebPage", "WebSite", "Organization", "Person", "PostalAddress",
  "ContactPoint", "OpeningHoursSpecification", "AggregateRating",
  "ImageObject", "BreadcrumbList", "ListItem", "Offer", "ItemList",
]);

function buildPropertyHints(
  types: string[],
  brain: SchemaBrain,
  classification?: PageClassification,
  base: Entity[] = [],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!brain.loaded) return out;

  // Hint the types the LLM is actually likely to emit: the classification
  // hints and their subtypes, everything already in the base graph, and a
  // structural set. The hint list is a property whitelist ("do NOT invent
  // property names"), so a stingy list caps achievable depth — keep it wide.
  const priority = new Set<string>(ALWAYS_HINT_TYPES);
  if (classification) {
    priority.add(classification.primaryHint);
    for (const h of classification.additionalHints) priority.add(h);
    for (const hint of [classification.primaryHint, ...classification.additionalHints]) {
      for (const sub of brain.subTypesOf(hint).slice(0, 25)) priority.add(sub);
    }
  }
  for (const e of base) {
    for (const t of Array.isArray(e.type) ? e.type : [e.type]) priority.add(t);
  }

  for (const t of types) {
    if (!priority.has(t)) continue;
    const props = brain.propertiesFor(t);
    if (props.length) out[t] = props.slice(0, 160);
  }
  return out;
}

function safeParse(raw: string): unknown {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (match && match[0]) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
