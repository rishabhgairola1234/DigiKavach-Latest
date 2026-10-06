import { SchemaType, type Schema } from "@google/generative-ai";
import { generateJson } from "@/lib/llm";
import { CATEGORY_LABEL, type ComplaintCategory, type ExtractedComplaintData } from "@/lib/complaints";

export type SuggestedLegalSection = {
  section: string;
  title: string;
  reason: string;
};

const legalSectionsSchema: Schema = {
  type: SchemaType.ARRAY,
  description: "1 to 3 of the most relevant applicable legal sections, most relevant first.",
  items: {
    type: SchemaType.OBJECT,
    properties: {
      section: {
        type: SchemaType.STRING,
        description:
          "The current BNS or BNSS section, e.g. 'BNS Section 304' or 'BNSS Section 173'. Never cite IPC/CrPC " +
          "as the primary citation. Optionally append the old IPC/CrPC equivalent in brackets if you're " +
          "confident of the mapping, e.g. 'BNS Section 304 (IPC Section 379)' -- omit the brackets entirely " +
          "if unsure of the old equivalent rather than guessing. No other wording, no year, no spelled-out act name.",
      },
      title: {
        type: SchemaType.STRING,
        description: "A short title for the offense this section covers, e.g. 'Theft'.",
      },
      reason: {
        type: SchemaType.STRING,
        description: "One sentence explaining why this section applies to this specific case.",
      },
    },
    required: ["section", "title", "reason"],
  },
};

const SYSTEM_INSTRUCTION = `You suggest likely applicable Indian criminal law sections for a police case,
as a reference starting point for the investigating officer -- this is not a legal determination. Cite
only from the Bharatiya Nyaya Sanhita (BNS, 2023), which replaced the Indian Penal Code (IPC) with effect
from 1 July 2024, and the Bharatiya Nagarik Suraksha Sanhita (BNSS), which replaced the Code of Criminal
Procedure (CrPC), for any procedural section. Never cite the IPC or CrPC as the primary citation -- those
codes are no longer in force. You may optionally add the old IPC/CrPC equivalent in brackets after the BNS/
BNSS citation if you are genuinely confident of the mapping (e.g. "BNS Section 304 (IPC Section 379)"); if
you aren't confident of the old equivalent, just omit the brackets rather than guessing.

Be conservative: suggest a section only when the stated facts clearly support every element of that
offense, not merely a related or adjacent one. In particular, distinguish theft/snatching from robbery --
snatching a bag or phone is theft/snatching; it only becomes robbery if the facts describe force, hurt,
wrongful restraint, or a threat used against the person to take the property or escape with it. Don't
escalate to the more serious offense without that explicit support in the text. Apply the same discipline
to every other category (e.g. simple hurt vs. grievous hurt, criminal intimidation vs. assault) -- when in
doubt, prefer the lesser offense that is actually supported by the facts, or omit the section rather than
pad the list with a weak or generic match.

Suggest 1 to 3 of the MOST relevant sections based on the case's category, description, and extracted
details. Respond with JSON matching the given schema only.`;

function formatContext(
  category: ComplaintCategory | null,
  description: string,
  extractedData: ExtractedComplaintData | null
): string {
  const lines = [
    `Category: ${category ? CATEGORY_LABEL[category] : "Unclassified"}`,
    `Description: ${description}`,
  ];

  if (extractedData) {
    const { people, vehicles } = extractedData;
    if (people.length) {
      lines.push("", "People involved:", people.map((p) => `- ${p.description}`).join("\n"));
    }
    if (vehicles.length) {
      lines.push("", "Vehicles involved:", vehicles.map((v) => `- ${v.type}`).join("\n"));
    }
  }

  return lines.join("\n");
}

/**
 * Suggests applicable BNS/IPC sections for one case. Returns null on any
 * failure -- this is a supplementary aid, not core functionality, so callers
 * must fail silently (just don't render the section) rather than show an error.
 */
export async function suggestLegalSections(
  category: ComplaintCategory | null,
  description: string,
  extractedData: ExtractedComplaintData | null
): Promise<SuggestedLegalSection[] | null> {
  const parsed = await generateJson<SuggestedLegalSection[]>({
    label: "suggestLegalSections",
    system: SYSTEM_INSTRUCTION,
    prompt: formatContext(category, description, extractedData),
    schema: legalSectionsSchema,
  });

  return Array.isArray(parsed) && parsed.length ? parsed : null;
}
