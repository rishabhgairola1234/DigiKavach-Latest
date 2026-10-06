"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { ComplaintPriority } from "@/lib/complaints";
import { parseMatchedOn, encodeEntitySlug } from "@/lib/dossier";

// react-force-graph-2d is canvas-based and touches `window` at import time --
// same rule as leaflet in mini-map.tsx: `ssr: false` is what actually keeps
// it out of the server bundle, not just marking this file 'use client'.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[600px] w-full items-center justify-center text-sm text-muted">
      Loading case web...
    </div>
  ),
});

export type CaseWebNode = {
  id: string;
  title: string;
  priority: ComplaintPriority | null;
};

export type CaseWebLink = {
  source: string;
  target: string;
  matchedOn: string;
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
  unclassified: "#94a3b8",
};

const LINK_COLORS = {
  vehicle_plate: "#38bdf8",
  phone: "#a78bfa",
  person_name: "#f59e0b",
};

function matchedOnKind(matchedOn: string): keyof typeof LINK_COLORS | null {
  const kind = matchedOn.split(":")[0]?.trim();
  if (kind === "vehicle_plate" || kind === "phone" || kind === "person_name") return kind;
  return null;
}

// "vehicle_plate: DL01AB1234" -> "shared vehicle plate DL01AB1234", used to
// build the hover tooltip -- the canvas itself draws no link text anymore.
function humanizeMatchedOn(matchedOn: string): string {
  const [kind, ...rest] = matchedOn.split(":");
  const value = rest.join(":").trim();
  switch (kind?.trim()) {
    case "vehicle_plate":
      return `shared vehicle plate ${value}`;
    case "phone":
      return `shared phone ${value}`;
    case "person_name":
      return `shared name ${value}`;
    default:
      return matchedOn;
  }
}

// Undirected pair key, order-independent, used to group every link between
// the same two cases regardless of which side is source vs target.
function pairKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

// react-force-graph mutates a link's source/target from the original string
// id into the resolved node object once the simulation initializes -- this
// reads whichever shape is currently there.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function linkPairKeyFromRuntimeLink(link: any): string {
  const source = typeof link.source === "object" ? link.source.id : link.source;
  const target = typeof link.target === "object" ? link.target.id : link.target;
  return pairKey(source, target);
}

// Loosely typed on purpose -- react-force-graph-2d's generics don't survive
// being wrapped in next/dynamic (needed for ssr:false), so callback
// parameters come through as `any` regardless of what's declared here.
// Reading known fields off them directly is simpler and just as safe as
// fighting that with casts everywhere.
export function CaseWebGraph({
  nodes,
  links,
}: {
  nodes: CaseWebNode[];
  links: CaseWebLink[];
}) {
  const router = useRouter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const hasZoomedOnMeasureRef = useRef(false);

  // The canvas used to be mis-sized/offset on first load until something
  // (a window resize, a screenshot tool forcing a reflow) happened to
  // trigger a remeasure. Measure on mount and keep measuring on both a
  // plain resize listener and a ResizeObserver.
  //
  // Two things previously caused an infinite measure -> setDimensions ->
  // resize -> measure loop ("Maximum update depth exceeded"):
  // - getBoundingClientRect() includes the 1px border, so it never matched
  //   clientWidth/clientHeight (the content box the canvas actually fills),
  //   and canvas resizes nudged the container's own border-box size.
  // - The wrapper rendered the canvas in normal flow, so the canvas itself
  //   could affect the wrapper's measured size. Fixed below by making the
  //   wrapper `relative` and the canvas an `absolute inset-0` child, which
  //   makes the wrapper's size independent of its content entirely.
  // clientWidth/clientHeight are also already integers, and setDimensions
  // only fires when the rounded value actually moved by >= 1px.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setDimensions((prev) =>
        Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
          ? prev
          : { width, height }
      );
    };

    measure();
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);

  // Tighter spacing than the library defaults (tuned for much denser graphs)
  // plus an explicit center force so nodes settle inside the visible box
  // instead of drifting toward whichever edge the initial layout favored.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || dimensions.width === 0 || dimensions.height === 0) return;
    fg.d3Force("charge")?.strength(-150);
    fg.d3Force("link")?.distance(90);
    fg.d3Force("center")?.x(dimensions.width / 2).y(dimensions.height / 2);
  }, [nodes, links, dimensions]);

  // onEngineStop (below) covers every later settle, but this covers the
  // very first valid measurement, so the graph never flashes an
  // unzoomed/off-center state while waiting for the simulation to cool down.
  useEffect(() => {
    if (hasZoomedOnMeasureRef.current) return;
    if (dimensions.width === 0 || dimensions.height === 0) return;
    if (!fgRef.current) return;
    fgRef.current.zoomToFit(400, 60);
    hasZoomedOnMeasureRef.current = true;
  }, [dimensions]);

  // Groups every link between the same two cases so (a) a second reason for
  // an already-linked pair gets a different curvature instead of drawing
  // exactly on top of the first, and (b) the hover label can combine all
  // reasons into one line instead of one link hiding the other's reason.
  const { curvatureByLinkKey, combinedLabelByPairKey } = useMemo(() => {
    const groups = new Map<string, CaseWebLink[]>();
    for (const l of links) {
      const key = pairKey(l.source, l.target);
      const group = groups.get(key) ?? [];
      group.push(l);
      groups.set(key, group);
    }

    const curvature = new Map<string, number>();
    const combinedLabel = new Map<string, string>();
    for (const [key, group] of groups) {
      group.forEach((l, i) => {
        curvature.set(`${key}::${l.matchedOn}`, i * 0.25);
      });
      const joined = group.map((l) => humanizeMatchedOn(l.matchedOn)).join(", ");
      combinedLabel.set(key, joined.charAt(0).toUpperCase() + joined.slice(1));
    }
    return { curvatureByLinkKey: curvature, combinedLabelByPairKey: combinedLabel };
  }, [links]);

  const canRenderGraph = dimensions.width > 0 && dimensions.height > 0;

  return (
    <div
      ref={containerRef}
      className="relative min-w-0 h-[600px] w-full overflow-hidden rounded-xl border border-border bg-background"
    >
      {/* absolute so the canvas (sized off `dimensions`, which is measured from
          this wrapper) can never itself affect the wrapper's own size -- that
          feedback loop is what caused the infinite measure loop above. */}
      <div className="absolute inset-0">
        {/* eslint-disable @typescript-eslint/no-explicit-any */}
        {canRenderGraph && (
        <ForceGraph2D
          ref={fgRef}
          width={dimensions.width}
          height={dimensions.height}
          graphData={{ nodes: nodes as any, links: links as any }}
          backgroundColor="#0f172a"
          nodeId="id"
          nodeRelSize={5}
          cooldownTicks={100}
          minZoom={0.5}
          maxZoom={4}
          onEngineStop={() => fgRef.current?.zoomToFit(400, 60)}
          nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const color = PRIORITY_COLORS[node.priority ?? "unclassified"];
            const x = node.x ?? 0;
            const y = node.y ?? 0;

            ctx.beginPath();
            ctx.arc(x, y, 5, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = "#0f172a";
            ctx.stroke();

            const label: string =
              node.title.length > 22 ? `${node.title.slice(0, 22)}…` : node.title;
            const fontSize = 12 / globalScale;
            ctx.font = `${fontSize}px sans-serif`;
            ctx.fillStyle = "#e2e8f0";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(label, x, y + 8);
          }}
          linkColor={(link: any) => {
            const kind = matchedOnKind(link.matchedOn);
            return kind ? LINK_COLORS[kind] : LINK_COLORS.person_name;
          }}
          linkWidth={2.5}
          /* linkOpacity exists at runtime (default is a dim 0.2) but is missing from
             this version's .d.ts, same "loosely typed on purpose" situation as the
             callback params above. */
          {...({ linkOpacity: 0.9 } as any)}
          linkCurvature={(link: any) =>
            curvatureByLinkKey.get(`${linkPairKeyFromRuntimeLink(link)}::${link.matchedOn}`) ?? 0
          }
          linkLabel={(link: any) =>
            combinedLabelByPairKey.get(linkPairKeyFromRuntimeLink(link)) ?? humanizeMatchedOn(link.matchedOn)
          }
          onNodeClick={(node: any) => router.push(`/officer/cases/${node.id}`)}
          onLinkClick={(link: any) => {
            const entity = parseMatchedOn(link.matchedOn);
            if (entity) router.push(`/officer/dossier/${encodeEntitySlug(entity)}`);
          }}
          enableNodeDrag
        />
      )}
      {/* eslint-enable @typescript-eslint/no-explicit-any */}
      </div>
    </div>
  );
}
