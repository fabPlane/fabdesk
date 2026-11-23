import type { MarkupTool, StrokeModel } from "./strokes";
import { clearStrokes, emptyStrokes } from "./strokes";

export interface MarkupSession {
  open: boolean;
  tool: MarkupTool;
  strokes: StrokeModel;
}

export function closedMarkup(tool: MarkupTool = "pen"): MarkupSession {
  return { open: false, tool, strokes: emptyStrokes() };
}

export function enterMarkup(session: MarkupSession): MarkupSession {
  return { open: true, tool: session.tool, strokes: emptyStrokes() };
}

export function exitMarkup(session: MarkupSession): MarkupSession {
  return { open: false, tool: session.tool, strokes: clearStrokes(session.strokes) };
}

export function sendClearsMarkup(session: MarkupSession): MarkupSession {
  return exitMarkup(session);
}

export function setMarkupTool(session: MarkupSession, tool: MarkupTool): MarkupSession {
  return session.tool === tool ? session : { ...session, tool };
}

export type MarkupCaptureResult = {
  blob: Blob | null;
  context: string;
};

type CaptureFn = () => Promise<MarkupCaptureResult | null>;

let captureFn: CaptureFn | null = null;

/** Overlay registers the live drawing so the composer can snapshot on send. */
export function registerMarkupCapture(fn: CaptureFn | null): void {
  captureFn = fn;
}

export async function captureMarkupSnapshot(): Promise<MarkupCaptureResult | null> {
  return captureFn ? captureFn() : null;
}
