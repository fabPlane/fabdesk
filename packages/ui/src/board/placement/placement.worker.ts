import {
  analyzePlacement,
  readPlacement,
  clone,
  suggestPlacement,
  resizeBoard,
  relax,
  spaceParts,
  reviewPlacement,
  exportBoard,
  replaceFootprint,
  addPlacementFootprint,
  connectedNeighbors,
  nearestClearance,
  placementScore,
  type PlacementContext,
  type Point,
  type PlacementSession,
  type PlacementAnalysis,
  type PlacementReview,
} from "@fabdesk/client-core/placement";
export type PlacementJob =
  | { kind: "load"; text: string; name: string }
  | { kind: "analyze" | "relax" | "export"; session: PlacementSession }
  | { kind: "context"; session: PlacementSession; ids: string[] }
  | { kind: "improve"; session: PlacementSession; ids: string[]; allowRotation: boolean }
  | { kind: "resize"; session: PlacementSession; w: number; h: number; adjust: boolean }
  | { kind: "add"; session: PlacementSession; text: string; name: string; at?: Point }
  | { kind: "replace"; session: PlacementSession; id: string; text: string; name: string }
  | { kind: "space"; session: PlacementSession; ids: string[]; axis: string; gap: number };
export interface PlacementResult {
  session?: PlacementSession;
  analysis?: PlacementAnalysis;
  review?: PlacementReview;
  text?: string;
  error?: string;
  context?: PlacementContext;
  comparison?: {
    before: number;
    after: number;
    beforeScore: number;
    afterScore: number;
    timedOut: boolean;
  };
}
self.onmessage = (event: MessageEvent<PlacementJob>) => {
  const job = event.data;
  try {
    let result: PlacementResult;
    if (job.kind === "load") result = { session: readPlacement(job.text, job.name) };
    else if (job.kind === "analyze") result = { analysis: analyzePlacement(job.session) };
    else if (job.kind === "context")
      result = {
        context: {
          neighbors: connectedNeighbors(job.session, job.ids),
          gap: nearestClearance(job.session, job.ids),
        },
      };
    else if (job.kind === "export") result = { text: exportBoard(job.session) };
    else {
      let session = clone(job.session);
      let timedOut = false;
      if (job.kind === "improve") {
        const search = suggestPlacement(session, job.ids, {
          budgetMs: 1500,
          allowRotation: job.allowRotation,
        });
        session = search.candidate;
        timedOut = search.timedOut;
      }
      if (job.kind === "resize") resizeBoard(session, job.w, job.h, job.adjust);
      if (job.kind === "add") addPlacementFootprint(session, job.text, job.name, job.at);
      if (job.kind === "relax") relax(session);
      if (job.kind === "space") spaceParts(session, job.ids, job.axis, job.gap);
      if (job.kind === "replace") {
        const part = session.parts.find((p) => p.id === job.id);
        if (!part) throw new Error("Select a component before replacing its footprint.");
        replaceFootprint(part, job.text, job.name);
      }
      result = {
        session,
        review: reviewPlacement(job.session, session),
        analysis: analyzePlacement(session),
        comparison: {
          before: analyzePlacement(job.session).length,
          after: analyzePlacement(session).length,
          beforeScore: placementScore(job.session),
          afterScore: placementScore(session),
          timedOut,
        },
      };
      if (job.kind === "replace" && !result.review!.changed.some((p) => p.id === job.id)) {
        const p = session.parts.find((p) => p.id === job.id)!;
        result.review!.changed.push({
          id: p.id,
          ref: p.ref,
          from: [p.x, p.y, p.angle],
          to: [p.x, p.y, p.angle],
        });
      }
    }
    self.postMessage(result);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
