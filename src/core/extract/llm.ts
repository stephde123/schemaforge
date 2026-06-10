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
  const propertyHints = buildPropertyHints(candidateTypes, brain, classification);

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
Your mission: produce the MOST COMPREHENSIVE, SPECIFIC, and ACCURATE set of schema.org entities possible for the given web page.

## Core rules
- Choose the MOST SPECIFIC subtype available (e.g. Dentist over LocalBusiness, SoftwareApplication over WebPage for a software features page).
- Emit MULTIPLE entities when the page contains multiple distinct concepts (e.g. a software features page may need: SoftwareApplication + ItemList of features + Organization + WebPage).
- Only use properties listed in validPropertiesPerType. Do NOT invent property names.
- STRICT EXTRACTION ONLY: every value you emit must be explicitly present in the page text. Do NOT generate, guess, or infer URLs, email addresses, phone numbers, social media handles, identifiers, or any other data that is not literally written on the page. If a piece of information is not on the page, omit the property entirely.
- Do NOT emit sameAs under any circumstances — not for people, organizations, places, or any other entity type.
- Link entities by "@id" reference rather than deep nesting when the target entity is already in the graph.
- Output STRICT JSON: {"entities": [...]} where each element has "@type" plus properties. No markdown, no prose.

## What to look for per page type

### SoftwareApplication / Product pages
- Emit a SoftwareApplication (or more specific subtype like WebApplication, MobileApplication) as the primary entity.
- Populate: name, description, url, featureList (comma-separated features or array), applicationCategory, operatingSystem, offers (for pricing), screenshot, softwareVersion, releaseNotes.
- If the page lists features in sections/cards/grid → emit an ItemList whose itemListElement entries each have "@type": "ListItem", position, name, description.
- If pricing tiers exist → emit one Offer per tier with name, price, priceCurrency, description.
- If there is an AggregateRating → include ratingValue, reviewCount, bestRating.

### Article / Blog pages
- Emit Article (or BlogPosting / NewsArticle / TechArticle — whichever fits best).
- Populate: headline, description, datePublished, dateModified, author (Person), publisher (Organization), image, url, wordCount if estimable.
- If a Person authored it, emit a separate Person entity with name and optionally url.

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
- Be thorough: a low coverageScore means important entities or properties were missed.`;

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
      page: {
        url: input.canonicalUrl || input.sourceUrl,
        title: input.title,
        lang: input.lang,
        text: input.text.slice(0, 20000),
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
        ? 'The userInstruction field contains a MANDATORY directive from the user — execute it first, then analyze the full page text and emit ALL relevant entities. Return {"entities": [...]}.'
        : 'Analyze the full page text. Emit ALL relevant entities for this page. Return {"entities": [...]} with the most specific types and ALL relevant valid properties filled in. Be comprehensive.',
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
  "PizzaRestaurant", "Winery",

  // Local business subtypes — lodging
  "LodgingBusiness", "Hotel", "Hostel", "BedAndBreakfast", "Motel", "Resort",
  "VacationRental",

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
  "Article", "BlogPosting", "NewsArticle", "TechArticle",
  "AnalysisNewsArticle", "OpinionNewsArticle", "ReviewNewsArticle",
  "HowTo", "HowToStep", "HowToSection", "Recipe",

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

  // Expand ONLY the classification hints to their direct subtypes — not all
  // BASE_SEEDS, which generates ~2000 types and blows the token budget.
  if (brain.loaded && classification) {
    const hintsToExpand = [classification.primaryHint, ...classification.additionalHints];
    for (const hint of hintsToExpand) {
      for (const sub of brain.subTypesOf(hint).slice(0, 10)) seeds.add(sub);
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
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!brain.loaded) return out;

  // Only emit hints for classification-driven types + a small structural set.
  // GPT-4o already knows all schema.org properties; hints exist only to
  // constrain property names — so covering the 10-20 most likely types is enough.
  const priority = new Set<string>([
    ...(classification ? [classification.primaryHint, ...classification.additionalHints] : []),
    ...ALWAYS_HINT_TYPES,
  ]);

  for (const t of types) {
    if (!priority.has(t)) continue;
    const props = brain.propertiesFor(t);
    if (props.length) out[t] = props.slice(0, 80);
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
