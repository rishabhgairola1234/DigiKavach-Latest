// One-off backfill: re-geocodes every complaint whose latitude/longitude are
// currently null (run the clear-coordinates SQL in supabase/reset-location-sql
// -- see the task notes -- first) using the same Dehradun-preference logic as
// src/lib/geocoding.ts, kept self-contained here (plain JS, no TS path-alias
// loader needed) so this script keeps working even if that file changes.
//
// Needs a Supabase SERVICE ROLE key -- civilians/officers have no UPDATE
// grant on latitude/longitude/resolved_location_name at all (see
// supabase/schema.sql Steps 15 and 18), so the anon key can't write this
// backfill. Add SUPABASE_SERVICE_ROLE_KEY to .env.local temporarily (from
// Supabase Dashboard -> Project Settings -> API -> service_role secret),
// run this script once, then remove it from .env.local again.
//
// Usage: node scripts/regeocode-complaints.mjs

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const envContent = readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
function envVar(name) {
  const match = envContent.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1].trim() : undefined;
}

const url = envVar("NEXT_PUBLIC_SUPABASE_URL");
const serviceRoleKey = envVar("SUPABASE_SERVICE_ROLE_KEY");

if (!serviceRoleKey) {
  console.error(
    "SUPABASE_SERVICE_ROLE_KEY is not set in .env.local. Add it temporarily " +
      "(Supabase Dashboard -> Project Settings -> API -> service_role secret), then re-run."
  );
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey);

const DEFAULT_CITY = "Dehradun";
const DEFAULT_STATE = "Uttarakhand";
const DEFAULT_COUNTRY = "India";
const DEHRADUN_VIEWBOX = { minLat: 30.15, maxLat: 30.5, minLng: 77.85, maxLng: 78.3 };
const USER_AGENT = "DigiKavach/1.0 (Crime Reporting & Investigation Platform)";
const MIN_REQUEST_GAP_MS = 1000;

function isWithinDehradunViewbox(lat, lng) {
  return (
    lat >= DEHRADUN_VIEWBOX.minLat &&
    lat <= DEHRADUN_VIEWBOX.maxLat &&
    lng >= DEHRADUN_VIEWBOX.minLng &&
    lng <= DEHRADUN_VIEWBOX.maxLng
  );
}

// Nominatim matches these as literal address substrings rather than
// understanding them as "near this landmark" -- "near Clock Tower" ends up
// matching addresses that literally contain "near clock tower", often a
// completely different, wrong candidate set.
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

function stripFillerWords(text) {
  let result = text;
  for (const phrase of FILLER_PHRASES) {
    const pattern = new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "gi");
    result = result.replace(pattern, " ");
  }
  return result.replace(/\s+/g, " ").trim();
}

// Not exhaustive -- a heuristic for "did the civilian already name a place".
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

function namesKnownPlace(text) {
  if (/,\s*\S/.test(text)) return true;
  const lower = text.toLowerCase();
  return KNOWN_PLACE_NAMES.some((name) => new RegExp(`\\b${name}\\b`).test(lower));
}

async function fetchCandidates(query) {
  const viewbox = [
    DEHRADUN_VIEWBOX.minLng,
    DEHRADUN_VIEWBOX.maxLat,
    DEHRADUN_VIEWBOX.maxLng,
    DEHRADUN_VIEWBOX.minLat,
  ].join(",");

  const url =
    `https://nominatim.openstreetmap.org/search?format=json&limit=8&countrycodes=in` +
    `&viewbox=${viewbox}&bounded=0&q=${encodeURIComponent(query)}`;

  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    console.error(`  Nominatim returned ${response.status} for "${query}"`);
    return [];
  }

  const results = await response.json();
  if (!Array.isArray(results)) return [];

  return results
    .map((r) => ({
      latitude: Number.parseFloat(r.lat),
      longitude: Number.parseFloat(r.lon),
      displayName: r.display_name,
    }))
    .filter((r) => !Number.isNaN(r.latitude) && !Number.isNaN(r.longitude));
}

function pickPreferredOrFirst(candidates) {
  if (candidates.length === 0) return null;
  const preferred = candidates.find((r) => isWithinDehradunViewbox(r.latitude, r.longitude));
  return preferred ?? candidates[0];
}

function pickOnlyIfInBox(candidates) {
  return candidates.find((r) => isWithinDehradunViewbox(r.latitude, r.longitude)) ?? null;
}

async function geocode(location) {
  const cleaned = stripFillerWords(location);

  if (namesKnownPlace(cleaned)) {
    return pickPreferredOrFirst(await fetchCandidates(cleaned));
  }

  let result = pickOnlyIfInBox(await fetchCandidates(cleaned));
  if (!result) {
    // 1 request/second between this complaint's own two calls too, not just
    // between complaints.
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_GAP_MS));
    result = pickOnlyIfInBox(
      await fetchCandidates(`${cleaned}, ${DEFAULT_CITY}, ${DEFAULT_STATE}, ${DEFAULT_COUNTRY}`)
    );
  }
  return result;
}

const { data: complaints, error } = await supabase
  .from("complaints")
  .select("id, location")
  .is("latitude", null)
  .not("location", "is", null);

if (error) {
  console.error("Failed to fetch complaints:", error);
  process.exit(1);
}

console.log(`Found ${complaints.length} complaint(s) needing geocoding.\n`);

let updated = 0;
let skipped = 0;

for (const complaint of complaints) {
  console.log(`[${complaint.id}] "${complaint.location}"`);
  const result = await geocode(complaint.location);

  if (!result) {
    console.log("  -> no result, leaving coordinates null");
    skipped++;
  } else {
    const { error: updateError } = await supabase
      .from("complaints")
      .update({
        latitude: result.latitude,
        longitude: result.longitude,
        resolved_location_name: result.displayName,
      })
      .eq("id", complaint.id);

    if (updateError) {
      console.error("  -> update failed:", updateError);
      skipped++;
    } else {
      console.log(`  -> resolved to ${result.displayName} (${result.latitude}, ${result.longitude})`);
      updated++;
    }
  }

  // Respect Nominatim's 1 request/second limit between complaints too.
  await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_GAP_MS));
}

console.log(`\nDone. ${updated} updated, ${skipped} skipped.`);
