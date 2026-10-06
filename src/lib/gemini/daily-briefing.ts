import { generateText } from "@/lib/llm";
import { CATEGORY_LABEL, type ComplaintCategory } from "@/lib/complaints";

export type LinkedCluster = {
  entityType: "vehicle_plate" | "person_name" | "phone";
  entityValue: string;
  caseTitles: string[];
};

export type BriefingContext = {
  newCases: { title: string; category: ComplaintCategory | null }[];
  overdueCases: { title: string }[];
  activeSosCount: number;
  trendAlerts: { category: ComplaintCategory; location: string; count: number }[];
  linkedClusters: LinkedCluster[];
  /** Current local time, ISO 8601, Asia/Kolkata -- lets the model avoid
   *  guessing "this morning"/"overnight" when the clock doesn't support it. */
  currentTimeIso: string;
};

const ENTITY_LABEL: Record<LinkedCluster["entityType"], string> = {
  vehicle_plate: "vehicle plate",
  person_name: "person",
  phone: "phone number",
};

const SYSTEM_INSTRUCTION = `You write a short daily briefing for a police officer opening their case
dashboard, based strictly on the counts and lists given to you -- never invent cases, numbers, or
details not present in the data. Write it as a short, readable paragraph (2-4 sentences) an officer
could read in about 10 seconds to get oriented, not a re-listing of raw stats or a bulleted report.

Mention what's genuinely worth their attention first, in this order of priority: (1) linked-case
clusters -- cases connected by a shared vehicle plate, phone number, or person -- naming the shared
plate or phone number itself and how many cases it ties together, since that's the strongest signal of
a pattern worth investigating together; (2) active SOS alerts; (3) overdue cases; (4) emerging trends.
Keep the tone calm and professional -- like a colleague handing off a quick verbal summary, not an
alarmist alert. If everything is quiet, say so briefly rather than padding it out.

You are given the current local time (Asia/Kolkata). Only use a time-of-day word like "this morning",
"overnight", "tonight", or "this afternoon" if that given time actually supports it -- e.g. don't say
"overnight" if it's the middle of the afternoon. When you're not confident the clock supports a specific
time word, use neutral phrasing instead, such as "since the last briefing" or "recently".

Output plain text only, no markdown, no headers.`;

function formatContext(context: BriefingContext): string {
  const lines = [
    `Current local time (Asia/Kolkata): ${context.currentTimeIso}`,
    "",
    `Linked case clusters (cases connected by a shared entity): ${context.linkedClusters.length}`,
    context.linkedClusters.length
      ? context.linkedClusters
          .map(
            (l) =>
              `- Shared ${ENTITY_LABEL[l.entityType]} "${l.entityValue}" links ${l.caseTitles.length} cases: ` +
              l.caseTitles.map((t) => `"${t}"`).join(", ")
          )
          .join("\n")
      : "",
    "",
    `New cases filed in the last 24 hours: ${context.newCases.length}`,
    context.newCases.length
      ? context.newCases
          .map((c) => `- ${c.title} (${c.category ? CATEGORY_LABEL[c.category] : "unclassified"})`)
          .join("\n")
      : "",
    "",
    `Currently overdue cases: ${context.overdueCases.length}`,
    context.overdueCases.length ? context.overdueCases.map((c) => `- ${c.title}`).join("\n") : "",
    "",
    `Active SOS alerts: ${context.activeSosCount}`,
    "",
    `Active trend alerts (clusters of similar cases in one area): ${context.trendAlerts.length}`,
    context.trendAlerts.length
      ? context.trendAlerts
          .map((t) => `- ${t.count}x ${CATEGORY_LABEL[t.category]} near ${t.location}`)
          .join("\n")
      : "",
  ];

  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Writes a short prose orientation briefing from aggregate dashboard data
 * already computed server-side. Manually triggered by the officer, so a
 * failure here must be surfaced, not swallowed.
 */
export async function generateDailyBriefing(context: BriefingContext): Promise<string | null> {
  return generateText({
    label: "generateDailyBriefing",
    system: SYSTEM_INSTRUCTION,
    prompt: `TODAY'S DASHBOARD DATA\n${formatContext(context)}\n\nWrite the briefing now.`,
  });
}
