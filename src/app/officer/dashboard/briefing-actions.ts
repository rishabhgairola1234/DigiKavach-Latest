"use server";

import { createClient } from "@/lib/supabase/server";
import { generateDailyBriefing, type LinkedCluster } from "@/lib/gemini/daily-briefing";
import { isCaseOverdue } from "@/lib/overdue";
import { detectTrends, TREND_LOOKBACK_DAYS, type TrendComplaint } from "@/lib/trend-detection";
import { parseMatchedOn, normalizedValueForEntity } from "@/lib/dossier";
import type { ComplaintStatus, ExtractedComplaintData } from "@/lib/complaints";

export type GenerateBriefingResult = { briefing: string | null; error: string | null };

/**
 * Recomputes every aggregate fresh, server-side, rather than trusting
 * whatever the client last rendered -- keeps this consistent with the
 * dashboard's own numbers and avoids serializing large arrays across the
 * client/server boundary just to pass them back in.
 */
export async function generateBriefing(): Promise<GenerateBriefingResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { briefing: null, error: "You must be logged in." };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "officer") {
    return { briefing: null, error: "Only officers can generate a briefing." };
  }

  const { data: complaints } = await supabase
    .from("complaints")
    .select("id, title, status, location, extracted_data, created_at");

  const { count: activeSosCount } = await supabase
    .from("sos_alerts")
    .select("*", { count: "exact", head: true })
    .eq("status", "active");

  const { data: linkRows } = await supabase
    .from("complaint_links")
    .select("complaint_id_a, complaint_id_b, matched_on");

  const rows = complaints ?? [];

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const newCases = rows
    .filter((c) => new Date(c.created_at).getTime() >= dayAgo)
    .map((c) => ({
      title: c.title,
      category: (c.extracted_data as ExtractedComplaintData | null)?.category ?? null,
    }));

  const overdueCases = rows
    .filter((c) =>
      isCaseOverdue({
        status: c.status as ComplaintStatus,
        extracted_data: c.extracted_data as ExtractedComplaintData | null,
        created_at: c.created_at,
      })
    )
    .map((c) => ({ title: c.title }));

  const lookbackCutoff = Date.now() - TREND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const recentForTrends: TrendComplaint[] = rows
    .filter((c) => c.extracted_data && new Date(c.created_at).getTime() >= lookbackCutoff)
    .map((c) => ({
      id: c.id,
      title: c.title,
      category: (c.extracted_data as ExtractedComplaintData).category,
      location: c.location,
      created_at: c.created_at,
    }));
  const trendAlerts = detectTrends(recentForTrends).map((t) => ({
    category: t.category,
    location: t.location,
    count: t.complaints.length,
  }));

  // Groups complaint_links by the shared entity (not by row -- a pair can
  // produce more than one row, e.g. a shared plate AND a shared phone), the
  // same approach as the Case Web page's "Key Entities" aggregation.
  const titleById = new Map(rows.map((c) => [c.id, c.title]));
  const clusterByKey = new Map<string, LinkedCluster>();
  for (const l of linkRows ?? []) {
    const entity = parseMatchedOn(l.matched_on);
    if (!entity) continue;

    const key = `${entity.type}:${normalizedValueForEntity(entity)}`;
    const newTitles = [titleById.get(l.complaint_id_a), titleById.get(l.complaint_id_b)].filter(
      (t): t is string => Boolean(t)
    );

    const existing = clusterByKey.get(key);
    if (existing) {
      for (const title of newTitles) {
        if (!existing.caseTitles.includes(title)) existing.caseTitles.push(title);
      }
    } else {
      clusterByKey.set(key, {
        entityType: entity.type,
        entityValue: entity.value,
        caseTitles: [...new Set(newTitles)],
      });
    }
  }
  const linkedClusters = [...clusterByKey.values()];

  const currentTimeIso =
    new Date().toLocaleString("en-GB", {
      timeZone: "Asia/Kolkata",
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " IST";

  const briefing = await generateDailyBriefing({
    newCases,
    overdueCases,
    activeSosCount: activeSosCount ?? 0,
    trendAlerts,
    linkedClusters,
    currentTimeIso,
  });

  if (!briefing) {
    return { briefing: null, error: "Couldn't generate the briefing right now. Please try again." };
  }

  return { briefing, error: null };
}
