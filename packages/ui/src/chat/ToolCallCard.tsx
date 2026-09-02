import type { MessagePart } from "@fabdesk/protocol";
import { useState } from "react";
import { Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { cn, isImagePath, stringifyPretty } from "../util";
import { ProjectImage } from "./ProjectImage";

type ToolUse = Extract<MessagePart, { type: "tool_use" }>;
type ToolResult = Extract<MessagePart, { type: "tool_result" }>;

export interface ExtractedImage {
  kind: "data" | "path";
  src: string;
  mime?: string;
}

/** Finds images in a tool result: MCP content blocks, `{type:"image"}` objects, or image file paths. */
export function extractImages(output: unknown, depth = 0): ExtractedImage[] {
  if (depth > 4 || output === null || output === undefined) return [];
  if (typeof output === "string") {
    if (output.startsWith("data:image/")) return [{ kind: "data", src: output }];
    if (isImagePath(output) && !output.includes("\n") && output.length < 400) return [{ kind: "path", src: output }];
    return [];
  }
  if (Array.isArray(output)) return output.flatMap((o) => extractImages(o, depth + 1));
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (o["type"] === "image" && typeof o["data"] === "string") {
      const mime = typeof o["mimeType"] === "string" ? o["mimeType"] : "image/png";
      return [{ kind: "data", src: `data:${mime};base64,${o["data"]}`, mime }];
    }
    if (o["type"] === "image" && typeof o["path"] === "string") return [{ kind: "path", src: o["path"] }];
    const out: ExtractedImage[] = [];
    for (const key of ["content", "result", "images", "image", "path", "png", "svg", "outputs", "files"]) {
      if (key in o) out.push(...extractImages(o[key], depth + 1));
    }
    return out;
  }
  return [];
}

/** Text from MCP-style `{content:[{type:"text",text}]}` results; otherwise pretty JSON. */
export function resultText(output: unknown): string {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const content = (output as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (c): c is { type: "text"; text: string } =>
            !!c && typeof c === "object" && (c as { type?: unknown }).type === "text",
        )
        .map((c) => c.text);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return stringifyPretty(output);
}

function summarizeArgs(input: unknown): string {
  if (!input || typeof input !== "object") return input === undefined ? "" : String(input);
  return Object.entries(input as Record<string, unknown>)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ")
    .slice(0, 100);
}

export function ToolCallCard({ use, result }: { use: ToolUse; result?: ToolResult | undefined }) {
  const [open, setOpen] = useState(false);
  const projectId = useUiStore((s) => s.activeProjectId);
  const pending = !result;
  const error = result?.isError === true;
  const images = result ? extractImages(result.output) : [];
  return (
    <div className={cn("my-1.5 rounded-lg border bg-panel-2/40 text-xs", error ? "border-danger/50" : "border-border")}>
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen((o) => !o)}>
        <span className={cn("inline-block text-muted transition-transform", open && "rotate-90")}>&#9656;</span>
        <span className="font-mono font-medium">{use.name}</span>
        <span className="truncate text-muted">{summarizeArgs(use.input)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {pending && <Spinner className="h-3 w-3" />}
          {error && <span className="text-danger">error</span>}
          {!pending && !error && <span className="text-success">done</span>}
        </span>
      </button>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2.5 pb-2">
          {images.map((img, i) =>
            img.kind === "data" ? (
              <img key={i} src={img.src} alt="tool result" className="max-h-72 rounded border border-border" />
            ) : (
              <ProjectImage key={i} projectId={projectId} path={img.src} />
            ),
          )}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-border px-2.5 py-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">Arguments</div>
            <pre className="max-h-60 overflow-auto rounded bg-panel p-2 font-mono">{stringifyPretty(use.input)}</pre>
          </div>
          {result && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">Result</div>
              <pre className={cn("max-h-80 overflow-auto rounded bg-panel p-2 font-mono", error && "text-danger")}>
                {resultText(result.output)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
