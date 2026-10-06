import {
  DEFAULT_CITY,
  DEFAULT_STATE,
  DEFAULT_COUNTRY,
  DEHRADUN_VIEWBOX,
  isWithinDehradunViewbox,
} from "@/lib/geo-config";

export type GeocodedLocation = {
  latitude: number;
  longitude: number;
  /** Nominatim's own display_name for the resolved place, shown to officers
   *  so they can see what the free-text location actually resolved to. */
  displayName: string;
};

const USER_AGENT = "DigiKavach/1.0 (Crime Reporting & Investigation Platform)";

// Nominatim's usage policy caps this at 1 request/second. All calls go
// through this chain so they're serialized and spaced out, regardless of how
// many complaints are being filed concurrently.
let requestChain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
const MIN_REQUEST_GAP_MS = 1000;

function throttledFetch(url: string): Promise<Response> {
  const result = requestChain.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fetch(url, { headers: { "User-Agent": USER_AGENT } });
  });
  // Keep the chain alive even if this call throws, so later calls aren't
  // permanently blocked by one failure.
  requestChain = result.catch(() => undefined);
  return result;
}

// In-memory cache, keyed by the exact text geocoded -- avoids re-hitting
// Nominatim for the same free-text location (e.g. a common landmark name
// reused across several complaints). Capped with simple FIFO eviction so a
// long-running server process can't grow this unbounded.
const CACHE_MAX_ENTRIES = 1000;
const cache = new Map<string, GeocodedLocation | null>();

function cacheGet(key: string): GeocodedLocation | null | undefined {
  return cache.get(key);
}

function cacheSet(key: string, value: GeocodedLocation | null): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
}

// Nominatim's free-text search matches these literally against address
// fields rather than understanding them as relational prepositions -- "near
// Clock Tower" ends up matching addresses that literally contain the
// substring "near clock tower" instead of being read as "the Clock Tower
// landmark", often returning a completely different (and completely wrong)
// candidate set. Longer phrases are listed first so they're stripped whole,
// though \b-bounded matching means order rarely matters in practice.
const FILLER_PHRASES = [
  "in front of",
  "close to",
  "next to",
  "nearby",
  "near",
  "opposite",
  "beside",
  "behind",
  "outside",
  "inside",
  "around",
  "at",
  "by",
];

function stripFillerWords(text: string): string {
  let result = text;
  for (const phrase of FILLER_PHRASES) {
    const pattern = new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "gi");
    result = result.replace(pattern, " ");
  }
  return result.replace(/\s+/g, " ").trim();
}

// Not exhaustive -- a heuristic for "did the civilian already name a place
// other than (or including) Dehradun", so that case can be trusted to
// resolve wherever it actually names, including Dehradun itself.
const INDIAN_STATES_AND_UTS = [
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat",
  "haryana", "himachal pradesh", "jharkhand", "karnataka", "kerala", "madhya pradesh",
  "maharashtra", "manipur", "meghalaya", "mizoram", "nagaland", "odisha", "punjab", "rajasthan",
  "sikkim", "tamil nadu", "telangana", "tripura", "uttar pradesh", "uttarakhand", "west bengal",
  "andaman and nicobar", "chandigarh", "dadra and nagar haveli", "daman and diu",
  "jammu and kashmir", "ladakh", "lakshadweep", "puducherry", "delhi",
];
const MAJOR_INDIAN_CITIES = [
  "mumbai", "bengaluru", "bangalore", "hyderabad", "chennai", "kolkata", "pune", "ahmedabad",
  "surat", "jaipur", "lucknow", "kanpur", "nagpur", "indore", "thane", "bhopal",
  "visakhapatnam", "vadodara", "ghaziabad", "ludhiana", "agra", "nashik", "faridabad", "meerut",
  "rajkot", "varanasi", "srinagar", "amritsar", "allahabad", "prayagraj", "ranchi", "howrah",
  "coimbatore", "jabalpur", "gwalior", "vijayawada", "jodhpur", "madurai", "raipur", "kota",
  "guwahati", "dehradun", "shimla", "haridwar", "rishikesh", "mussoorie", "noida", "gurugram",
  "gurgaon",
];
const KNOWN_PLACE_NAMES = [...INDIAN_STATES_AND_UTS, ...MAJOR_INDIAN_CITIES];

function namesKnownPlace(text: string): boolean {
  if (/,\s*\S/.test(text)) return true; // a comma followed by more text, e.g. "Railway Station, Chennai"
  const lower = text.toLowerCase();
  return KNOWN_PLACE_NAMES.some((name) => new RegExp(`\\b${name}\\b`).test(lower));
}

type ParsedResult = { latitude: number; longitude: number; displayName: string };

async function fetchCandidates(query: string): Promise<ParsedResult[]> {
  // viewbox + bounded=0 is a ranking PREFERENCE, not a restriction, so a
  // query naming another place can still resolve there -- see the
  // namesKnownPlace() branch below, which searches without ever rejecting
  // an out-of-box result for that case.
  const viewbox = [
    DEHRADUN_VIEWBOX.minLng,
    DEHRADUN_VIEWBOX.maxLat,
    DEHRADUN_VIEWBOX.maxLng,
    DEHRADUN_VIEWBOX.minLat,
  ].join(",");

  const url =
    `https://nominatim.openstreetmap.org/search?format=json&limit=8&countrycodes=in` +
    `&viewbox=${viewbox}&bounded=0&q=${encodeURIComponent(query)}`;

  const response = await throttledFetch(url);
  if (!response.ok) {
    console.error(`[geocodeLocation] Nominatim returned ${response.status} for "${query}"`);
    return [];
  }

  const results = (await response.json()) as { lat: string; lon: string; display_name: string }[];
  if (!Array.isArray(results)) return [];

  return results
    .map((r) => ({
      latitude: Number.parseFloat(r.lat),
      longitude: Number.parseFloat(r.lon),
      displayName: r.display_name,
    }))
    .filter((r) => !Number.isNaN(r.latitude) && !Number.isNaN(r.longitude));
}

// For a query that already names a place: Nominatim's own importance-based
// ranking often outranks a same-relevance Dehradun match even with viewbox
// set (confirmed live: "Railway Station" alone -- before filler-word
// stripping/place detection existed -- put a Chennai result #1 over an
// existing-but-lower-ranked Dehradun one), so this still prefers whichever
// candidate falls in the Dehradun box if one exists, otherwise takes
// Nominatim's own top result. In practice a query that names another
// city/state has no Dehradun-area candidate in its results at all
// (Nominatim's own text matching excludes it), so this isn't normally
// reachable for an explicitly-named other place -- it mainly matters when
// the name happens to BE Dehradun/Uttarakhand.
function pickPreferredOrFirst(candidates: ParsedResult[]): GeocodedLocation | null {
  if (candidates.length === 0) return null;
  const preferred = candidates.find((r) => isWithinDehradunViewbox(r.latitude, r.longitude));
  return preferred ?? candidates[0];
}

// For a query with no place named: only a Dehradun-area candidate is
// acceptable. Never falls back to an out-of-box top result -- better to
// store no coordinates than a wrong point halfway across India.
function pickOnlyIfInBox(candidates: ParsedResult[]): GeocodedLocation | null {
  return candidates.find((r) => isWithinDehradunViewbox(r.latitude, r.longitude)) ?? null;
}

/**
 * Best-effort geocoding of free-text location via Nominatim (OpenStreetMap's
 * free geocoding service -- no API key). Called once at complaint filing
 * time, server-side (a custom User-Agent, required by Nominatim's usage
 * policy, can only be set from a server request, not a browser fetch).
 *
 * Strips relational filler words ("near", "opposite", "next to", ...) first,
 * since Nominatim matches them as literal address substrings rather than
 * understanding them as "near this landmark", which otherwise returns a
 * completely unrelated candidate set.
 *
 * Then branches on whether the (cleaned) text already names a place:
 * - If it does (a comma followed by more text, or a known state/city name),
 *   it's searched as typed and the result is trusted, even if that place
 *   isn't Dehradun -- see pickPreferredOrFirst.
 * - If it doesn't, only a candidate inside the Dehradun viewbox is ever
 *   accepted; if none, it retries once with ", Dehradun, Uttarakhand, India"
 *   appended; if that still has no in-box candidate, this returns null
 *   rather than a wrong point on the map.
 */
export async function geocodeLocation(location: string): Promise<GeocodedLocation | null> {
  const trimmed = location.trim();
  if (!trimmed) return null;

  const cacheKey = trimmed.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let result: GeocodedLocation | null = null;
  try {
    const cleaned = stripFillerWords(trimmed);

    if (namesKnownPlace(cleaned)) {
      result = pickPreferredOrFirst(await fetchCandidates(cleaned));
    } else {
      result = pickOnlyIfInBox(await fetchCandidates(cleaned));
      if (!result) {
        result = pickOnlyIfInBox(
          await fetchCandidates(`${cleaned}, ${DEFAULT_CITY}, ${DEFAULT_STATE}, ${DEFAULT_COUNTRY}`)
        );
      }
    }
  } catch (err) {
    console.error(`[geocodeLocation] Failed to geocode "${trimmed}":`, err);
    result = null;
  }

  cacheSet(cacheKey, result);
  return result;
}
