export type ComplaintLinkRow = {
  id: string;
  complaint_id_a: string;
  complaint_id_b: string;
  matched_on: string;
  created_at: string;
};

// Counts DISTINCT other cases, not link rows -- a pair sharing both a plate
// and a phone number produces two rows in complaint_links but is still only
// one "other case".
export function buildLinkCountMap(links: ComplaintLinkRow[]): Map<string, number> {
  const othersByComplaintId = new Map<string, Set<string>>();
  for (const link of links) {
    if (!othersByComplaintId.has(link.complaint_id_a)) {
      othersByComplaintId.set(link.complaint_id_a, new Set());
    }
    othersByComplaintId.get(link.complaint_id_a)!.add(link.complaint_id_b);

    if (!othersByComplaintId.has(link.complaint_id_b)) {
      othersByComplaintId.set(link.complaint_id_b, new Set());
    }
    othersByComplaintId.get(link.complaint_id_b)!.add(link.complaint_id_a);
  }

  const counts = new Map<string, number>();
  for (const [complaintId, others] of othersByComplaintId) {
    counts.set(complaintId, others.size);
  }
  return counts;
}

export function otherComplaintId(link: ComplaintLinkRow, currentId: string): string {
  return link.complaint_id_a === currentId ? link.complaint_id_b : link.complaint_id_a;
}
