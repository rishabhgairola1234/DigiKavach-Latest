import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ArrowLeft, Link2, Star, Car, User, Phone } from "lucide-react";
import { CaseWebGraph, type CaseWebNode, type CaseWebLink } from "./case-web-graph";
import type { ComplaintPriority, ExtractedComplaintData } from "@/lib/complaints";
import { Bilingual, BilingualInline } from "@/components/bilingual";
import {
  parseMatchedOn,
  normalizedValueForEntity,
  encodeEntitySlug,
  type EntityRef,
  type EntityType,
} from "@/lib/dossier";

const ENTITY_ICON: Record<EntityType, typeof Car> = {
  vehicle_plate: Car,
  person_name: User,
  phone: Phone,
};

export default async function CaseWebPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/officer/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "officer") redirect("/officer/login");

  const { data: linkRows } = await supabase
    .from("complaint_links")
    .select("complaint_id_a, complaint_id_b, matched_on");

  const links = linkRows ?? [];

  // Only cases with at least one link are worth showing -- an isolated case
  // would just be a lone dot cluttering the graph for no reason.
  const linkedCaseIds = [
    ...new Set(links.flatMap((l) => [l.complaint_id_a, l.complaint_id_b])),
  ];

  const { data: complaintRows } = linkedCaseIds.length
    ? await supabase
        .from("complaints")
        .select("id, title, extracted_data")
        .in("id", linkedCaseIds)
    : { data: [] };

  const nodes: CaseWebNode[] = (complaintRows ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    priority: (c.extracted_data as ExtractedComplaintData | null)?.priority as
      | ComplaintPriority
      | null,
  }));

  const graphLinks: CaseWebLink[] = links.map((l) => ({
    source: l.complaint_id_a,
    target: l.complaint_id_b,
    matchedOn: l.matched_on,
  }));

  // "Key Entities": which single vehicle plate / person / phone number shows
  // up across the most distinct cases, straight from complaint_links -- pure
  // aggregation over data the trigger already computed, no new AI call. Each
  // entity can produce more than one link row once 3+ cases share it (every
  // pair gets its own row), so this counts the distinct case ids touched by
  // an entity's rows rather than the row count itself.
  const entityCaseIds = new Map<string, { entity: EntityRef; caseIds: Set<string> }>();
  for (const l of links) {
    const entity = parseMatchedOn(l.matched_on);
    if (!entity) continue;
    const key = `${entity.type}:${normalizedValueForEntity(entity)}`;
    const existing = entityCaseIds.get(key);
    if (existing) {
      existing.caseIds.add(l.complaint_id_a);
      existing.caseIds.add(l.complaint_id_b);
    } else {
      entityCaseIds.set(key, { entity, caseIds: new Set([l.complaint_id_a, l.complaint_id_b]) });
    }
  }
  const keyEntities = [...entityCaseIds.values()]
    .map(({ entity, caseIds }) => ({ entity, count: caseIds.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return (
    <div className="flex flex-1 flex-col overflow-x-hidden bg-background bg-grid px-6 py-10">
      <div className="mx-auto w-full max-w-6xl min-w-0">
        <Link
          href="/officer/dashboard"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted transition-all hover:text-foreground active:scale-[0.98]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <Bilingual en="Back to dashboard" hi="डैशबोर्ड पर वापस जाएं" />
        </Link>

        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-strong">
            <Link2 className="h-5 w-5" />
          </div>
          <div>
            <Bilingual
              as="h1"
              en="Case Web"
              hi="केस वेब"
              className="text-xl font-semibold text-foreground"
              hiClassName="ml-1.5 text-sm font-normal text-muted"
            />
            <p className="text-sm text-muted">
              Cases linked by a shared vehicle plate, person name, or phone
              number. Click a node to open that case, click a link to view
              its shared entity&apos;s dossier.
            </p>
          </div>
        </div>

        {nodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border p-16 text-center">
            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
              <Link2 className="h-6 w-6" />
            </div>
            <Bilingual
              as="h3"
              en="No linked cases yet"
              hi="अभी तक कोई जुड़ा मामला नहीं"
              className="text-lg font-semibold text-foreground"
              hiClassName="block text-sm font-normal text-muted"
            />
            <p className="mt-2 max-w-sm text-sm text-muted">
              Once two or more cases share a vehicle plate, person name, or
              phone number, they&apos;ll show up here connected in a graph.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px] min-w-0">
            <div className="min-w-0">
              <div className="mb-4 flex flex-wrap items-center gap-4 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-priority-high" />
                  <BilingualInline en="High priority" hi="उच्च प्राथमिकता" />
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-priority-medium" />
                  <BilingualInline en="Medium priority" hi="मध्यम प्राथमिकता" />
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-priority-low" />
                  <BilingualInline en="Low priority" hi="निम्न प्राथमिकता" />
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-muted" />
                  <BilingualInline en="Unclassified" hi="अवर्गीकृत" />
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4 bg-accent-strong" />
                  <BilingualInline en="Vehicle plate match" hi="वाहन नंबर प्लेट मेल" />
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4 bg-priority-medium" />
                  <BilingualInline en="Person name match" hi="व्यक्ति नाम मेल" />
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4" style={{ backgroundColor: "#a78bfa" }} />
                  <BilingualInline en="Phone number match" hi="फ़ोन नंबर मेल" />
                </span>
              </div>
              <CaseWebGraph nodes={nodes} links={graphLinks} />
            </div>

            {keyEntities.length > 0 && (
              <aside className="h-fit rounded-xl border border-border bg-background-elevated p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Star className="h-4 w-4 text-priority-medium" />
                  <Bilingual
                    as="h2"
                    en="Key Entities"
                    hi="प्रमुख इकाइयां"
                    className="text-sm font-semibold text-foreground"
                    hiClassName="ml-1 text-xs font-normal text-muted"
                  />
                </div>
                <p className="mb-3 text-xs text-muted">
                  Ranked by how many distinct cases each one appears in.
                </p>
                <ul className="flex flex-col gap-2">
                  {keyEntities.map(({ entity, count }, i) => {
                    const Icon = ENTITY_ICON[entity.type];
                    return (
                      <li key={`${entity.type}:${entity.value}`}>
                        <Link
                          href={`/officer/dossier/${encodeEntitySlug(entity)}`}
                          className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5 text-sm transition-all hover:border-accent/50 active:scale-[0.98]"
                        >
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent-strong">
                            {i + 1}
                          </span>
                          <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                            {entity.value}
                          </span>
                          <span className="shrink-0 text-xs text-muted">
                            {count} case{count === 1 ? "" : "s"}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
