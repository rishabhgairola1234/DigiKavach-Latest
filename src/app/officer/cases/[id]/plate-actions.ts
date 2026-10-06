"use server";

import { SchemaType, type Schema } from "@google/generative-ai";
import { createClient } from "@/lib/supabase/server";
import { generateFromImage } from "@/lib/llm";
import {
  normalizePlate,
  MIN_PLATE_LENGTH,
  isPlausibleIndianPlate,
  type PlateMatch,
} from "@/lib/plate-matching";
import type { ExtractedComplaintData } from "@/lib/complaints";

/**
 * Cross-references OCR-read plate text against every complaint's
 * extracted_data.vehicles. Returns null on no match, no auth, wrong role, or
 * any other failure -- this is a supplementary live-camera aid, not core
 * functionality, so it fails silently the same way legal-section suggestions
 * and other optional AI aids do elsewhere in this app.
 */
export async function findCaseByPlate(candidatePlates: string[]): Promise<PlateMatch | null> {
  const normalizedCandidates = [
    ...new Set(
      candidatePlates
        .map(normalizePlate)
        .filter((p) => p.length >= MIN_PLATE_LENGTH && isPlausibleIndianPlate(p))
    ),
  ];
  if (normalizedCandidates.length === 0) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "officer") return null;

  const { data: complaints } = await supabase
    .from("complaints")
    .select("id, title, created_at, extracted_data")
    .not("extracted_data", "is", null);

  for (const complaint of complaints ?? []) {
    const extracted = complaint.extracted_data as ExtractedComplaintData | null;
    if (!extracted) continue;

    for (const vehicle of extracted.vehicles) {
      if (!vehicle.plate_number) continue;
      const normalized = normalizePlate(vehicle.plate_number);
      if (normalized.length >= MIN_PLATE_LENGTH && normalizedCandidates.includes(normalized)) {
        return {
          complaintId: complaint.id,
          title: complaint.title,
          createdAt: complaint.created_at,
          matchedPlate: normalized,
        };
      }
    }
  }

  return null;
}

const plateReadSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    plate: {
      type: SchemaType.STRING,
      nullable: true,
      description: "The vehicle number plate exactly as read, or null if none is clearly visible.",
    },
    confidence: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ["high", "medium", "low"],
      description: "How confident you are in the plate reading.",
    },
  },
  required: ["plate", "confidence"],
};

const PLATE_READ_SYSTEM_INSTRUCTION = `You read vehicle number plates from a single image for a police
officer's reference. Read ONLY the plate -- never guess or invent characters you can't clearly make out.
Respond with JSON matching the given schema only.`;

const PLATE_READ_PROMPT =
  "Read the vehicle number plate in this image. Return JSON {plate: string|null, " +
  "confidence: 'high'|'medium'|'low'}. Return null if no plate is clearly visible. Do not guess.";

export type ReadPlateWithAiResult = {
  plate: string | null;
  confidence: "high" | "medium" | "low" | null;
  match: PlateMatch | null;
  error: string | null;
};

/**
 * On-demand, officer-triggered plate read via a vision-capable LLM (Gemini
 * first, Groq fallback -- see generateFromImage in src/lib/llm.ts), as
 * opposed to the continuous background OCR loop. Cross-references the same
 * way via findCaseByPlate once a plausible plate is read.
 */
export async function readPlateWithAI(imageDataUrl: string): Promise<ReadPlateWithAiResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { plate: null, confidence: null, match: null, error: "You must be logged in." };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "officer") {
    return { plate: null, confidence: null, match: null, error: "Only officers can use AI plate reading." };
  }

  const dataUrlMatch = imageDataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!dataUrlMatch) {
    return { plate: null, confidence: null, match: null, error: "Invalid image data." };
  }
  const [, mimeType, imageBase64] = dataUrlMatch;

  const result = await generateFromImage<{ plate: string | null; confidence: "high" | "medium" | "low" }>(
    {
      label: "readPlateWithAI",
      system: PLATE_READ_SYSTEM_INSTRUCTION,
      prompt: PLATE_READ_PROMPT,
      imageBase64,
      mimeType,
      schema: plateReadSchema,
    }
  );

  if (!result) {
    return { plate: null, confidence: null, match: null, error: "AI plate reading unavailable." };
  }

  if (!result.plate) {
    return { plate: null, confidence: result.confidence, match: null, error: null };
  }

  const normalized = normalizePlate(result.plate);
  if (normalized.length < MIN_PLATE_LENGTH || !isPlausibleIndianPlate(normalized)) {
    return { plate: null, confidence: result.confidence, match: null, error: null };
  }

  const match = await findCaseByPlate([normalized]);

  return { plate: normalized, confidence: result.confidence, match, error: null };
}
