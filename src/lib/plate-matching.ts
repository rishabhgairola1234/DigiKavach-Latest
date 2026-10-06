// Mirrors the normalization used by the link_related_complaints database
// trigger (supabase/schema.sql, Step 9): uppercase, strip everything but
// letters and digits. Kept as one small pure function so the two places that
// need "is this the same plate" logic can never drift apart.
export function normalizePlate(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export const MIN_PLATE_LENGTH = 4;

// Standard Indian vehicle registration format: 2-letter state code, 1-2
// digit RTO code, 0-3 letter series, 4 digit number (8-10 chars total).
// Applied only to fresh OCR candidates before they're allowed to even be
// proposed for matching -- stored plates (already AI-extracted from a
// complaint's own text) are left as-is, this only tightens what a live
// camera read is allowed to claim, cutting down false positives from OCR
// noise that happens to be 4+ alphanumeric characters.
const INDIAN_PLATE_FORMAT = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/;

export function isPlausibleIndianPlate(normalized: string): boolean {
  return INDIAN_PLATE_FORMAT.test(normalized);
}

export type PlateMatch = {
  complaintId: string;
  title: string;
  createdAt: string;
  matchedPlate: string;
};
