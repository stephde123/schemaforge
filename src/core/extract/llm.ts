import type { Entity, NormalizedInput } from "../types.js";
import type { SchemaBrain } from "../schema-brain.js";
import type { LlmProvider } from "../llm/provider.js";
import type { PageClassification } from "../classify.js";

export async function llmExtract(
  input: NormalizedInput,
  base: Entity[],
  brain: SchemaBrain,
  llm: LlmProvider,
  classification?: PageClassification,
): Promise<Entity[]> {
  const candidateTypes = pickCandidateTypes(base, brain, classification);
  const propertyHints = buildPropertyHints(candidateTypes, brain);

  const raw = await llm.complete(SYSTEM_PROMPT, buildUserPrompt(input, base, candidateTypes, propertyHints, classification));
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
      const { "@type": type, "@id": id, ...rest } = n;
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
- Do NOT invent facts — only encode information supported by the page text.
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
- If a Person authored it, emit a separate Person entity with name and optionally url/sameAs.

### FAQ pages
- Emit FAQPage with mainEntity as an array of Question objects, each with name and acceptedAnswer (Answer with text).
- Be exhaustive — capture every Q&A pair visible on the page.

### HowTo / Tutorial pages
- Emit HowTo with name, description, step (array of HowToStep with name, text, position).
- Include supply/tool if mentioned.

### Place of Worship / Religious Site / Historical Landmark pages
- Emit the MOST SPECIFIC type: CatholicChurch, BuddhistTemple, HinduTemple, Mosque, Synagogue, Church — or at minimum PlaceOfWorship.
- For famous/listed buildings also add LandmarksOrHistoricalBuildings and TouristAttraction as parallel types.
- Populate: name, alternateName, description, url, image, address (PostalAddress with streetAddress, postalCode, addressLocality, addressCountry), telephone, openingHoursSpecification or openingHours, geo (GeoCoordinates), hasMap, sameAs (Wikipedia, Wikidata, social profiles).
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

### Organization / About pages
- Emit Organization (or more specific: Corporation, EducationalOrganization, etc.) with: name, url, logo, description, foundingDate, numberOfEmployees, address, sameAs (social profiles).
- Emit Person entities for founders/team members if named.

### Product / E-commerce pages
- Emit Product with: name, description, image, sku, brand (Brand/Organization), offers (Offer with price, priceCurrency, availability, url), aggregateRating.

## General guidance
- Always emit a WebSite entity when the website name/url is identifiable.
- Always include BreadcrumbList if breadcrumbs are visible.
- Include sameAs with social media profile URLs when they appear in links.
- For any page: if there is a visible author/founder/team → emit Person entities.
- Be thorough: a low coverageScore means important entities or properties were missed.`;

function buildUserPrompt(
  input: NormalizedInput,
  base: Entity[],
  candidateTypes: string[],
  propertyHints: Record<string, string[]>,
  classification?: PageClassification,
): string {
  return JSON.stringify(
    {
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
      baseGraph: base.map((e) => ({
        "@id": e.id,
        "@type": e.type,
        ...e.props,
      })),
      candidateTypes,
      validPropertiesPerType: propertyHints,
      instruction:
        'Analyze the full page text. Emit ALL relevant entities for this page. Return {"entities": [...]} with the most specific types and ALL relevant valid properties filled in. Be comprehensive.',
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

  // Expand each seed to direct subtypes from the schema brain
  const expanded = new Set<string>(seeds);
  if (brain.loaded) {
    for (const seed of seeds) {
      for (const sub of brain.subTypesOf(seed).slice(0, 15)) expanded.add(sub);
    }
  }

  // Put classification primary hint and additional hints first so the LLM
  // sees the most relevant types at the top of the list
  const prioritized: string[] = [];
  if (classification) {
    prioritized.push(classification.primaryHint);
    prioritized.push(...classification.additionalHints);
  }
  const rest = [...expanded].filter((t) => !prioritized.includes(t));
  return [...new Set([...prioritized, ...rest])];
}

function buildPropertyHints(
  types: string[],
  brain: SchemaBrain,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!brain.loaded) return out;
  for (const t of types) {
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
