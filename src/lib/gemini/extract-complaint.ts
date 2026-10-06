import { SchemaType, type Schema } from "@google/generative-ai";
import { generateJson } from "@/lib/llm";
import type { ComplaintCategory, ComplaintPriority, ExtractedComplaintData } from "@/lib/complaints";

const CATEGORIES: ComplaintCategory[] = [
  "theft",
  "assault",
  "cybercrime",
  "harassment",
  "property_damage",
  "other",
];

const PRIORITIES: ComplaintPriority[] = ["low", "medium", "high"];

const extractionSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    people: {
      type: SchemaType.ARRAY,
      description: "Every person mentioned in the complaint, other than the complainant themself.",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: {
            type: SchemaType.STRING,
            nullable: true,
            description: "The person's name, if given.",
          },
          description: {
            type: SchemaType.STRING,
            description: "How this person relates to the incident (e.g. 'suspect', 'witness').",
          },
        },
        required: ["description"],
      },
    },
    vehicles: {
      type: SchemaType.ARRAY,
      description: "Every vehicle mentioned in the complaint.",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: {
            type: SchemaType.STRING,
            description: "e.g. 'car', 'motorcycle', 'auto-rickshaw'.",
          },
          plate_number: {
            type: SchemaType.STRING,
            nullable: true,
            description: "License plate number, if mentioned.",
          },
        },
        required: ["type"],
      },
    },
    phone_numbers: {
      type: SchemaType.ARRAY,
      description: "Every phone number mentioned in the complaint.",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          number: {
            type: SchemaType.STRING,
            description: "The phone number as written in the text.",
          },
          associated_with: {
            type: SchemaType.STRING,
            nullable: true,
            description:
              "Who this number belongs to or is associated with, if stated (e.g. 'suspect', " +
              "'witness', or a person's name).",
          },
        },
        required: ["number"],
      },
    },
    locations: {
      type: SchemaType.ARRAY,
      description: "Every place mentioned in the complaint, besides the primary incident location.",
      items: { type: SchemaType.STRING },
    },
    times: {
      type: SchemaType.ARRAY,
      description: "Every date/time reference mentioned besides the primary incident date/time.",
      items: { type: SchemaType.STRING },
    },
    category: {
      type: SchemaType.STRING,
      format: "enum",
      enum: CATEGORIES,
      description: "The single best-fitting category for this complaint.",
    },
    priority: {
      type: SchemaType.STRING,
      format: "enum",
      enum: PRIORITIES,
      description: "Urgency implied by the description — e.g. ongoing danger or violence is high.",
    },
  },
  required: ["people", "vehicles", "phone_numbers", "locations", "times", "category", "priority"],
};

const SYSTEM_INSTRUCTION = `You are a case intelligence assistant for a police complaint platform.
Read the complaint title and description and extract structured data for investigators.
Only include people, vehicles, phone numbers, locations, and times that are explicitly mentioned in
the text — never invent details. For phone numbers, capture the number as written and, if the text
states whose number it is (e.g. "suspect's number: 98XXXXXXXX"), record that association too.
Respond with JSON matching the given schema only.`;

/**
 * Calls Gemini to extract structured case data from a complaint. Returns null on any
 * failure (missing key, network error, malformed response) — callers must treat this as
 * "no extraction available" and must never let it block saving the complaint.
 */
export async function extractComplaintData(
  title: string,
  description: string
): Promise<ExtractedComplaintData | null> {
  const parsed = await generateJson<ExtractedComplaintData>({
    label: "extractComplaintData",
    system: SYSTEM_INSTRUCTION,
    prompt: `Complaint title: ${title}\n\nComplaint description: ${description}`,
    schema: extractionSchema,
  });

  if (!parsed) return null;

  // Other providers don't enforce the schema as strictly as Gemini, so make
  // sure the arrays downstream code iterates over always exist.
  return {
    ...parsed,
    people: parsed.people ?? [],
    vehicles: parsed.vehicles ?? [],
    phone_numbers: parsed.phone_numbers ?? [],
    locations: parsed.locations ?? [],
    times: parsed.times ?? [],
  };
}
