import type { MessagePart } from "@fabdesk/protocol";
import { useId, useState } from "react";
import { Icon } from "../components/Icon";
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

export function isCommandTool(name: string): boolean {
  return ["command_execution", "bash", "shell", "shell_command", "exec_command", "run_shell_command", "powershell"].includes(name.replace(/^mcp__.+?__/, "").replace(/^functions\./, "").toLowerCase());
}

export function isImageTool(name: string): boolean {
  return ["view_image", "image_view", "open_image"].includes(name.replace(/^mcp__.+?__/, "").replace(/^functions\./, "").toLowerCase());
}

function imagePath(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const args = input as Record<string, unknown>;
  const path = args["path"] ?? args["file_path"] ?? args["image_path"];
  return typeof path === "string" ? path.split(/[\\/]/).pop() ?? "" : "";
}

function commandText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const args = input as Record<string, unknown>;
  return typeof args["command"] === "string" ? args["command"] : typeof args["cmd"] === "string" ? args["cmd"] : "";
}

function summarizeArgs(input: unknown): string {
  if (!input || typeof input !== "object") return input === undefined ? "" : String(input);
  return Object.entries(input as Record<string, unknown>)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ")
    .slice(0, 100);
}

export function ToolCallCard({ use, result, streaming = false }: { use: ToolUse; result?: ToolResult | undefined; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const projectId = useUiStore((s) => s.activeProjectId);
  const pending = !result;
  const error = result?.isError === true;
  const images = result ? extractImages(result.output) : [];
  const command = isCommandTool(use.name);
  const viewingImage = isImageTool(use.name);
  const active = pending && streaming;
  const name = use.name.replace(/^mcp__.+?__/, "");
  const action = error ? "Failed" : pending ? (streaming ? "Running" : "Pending") : command ? "Ran" : "Used";
  const detail = command ? commandText(use.input) || name : [name, summarizeArgs(use.input)].filter(Boolean).join(" · ");
  const imageName = imagePath(use.input);
  const label = viewingImage
    ? (error ? "Could not view image" : pending ? (streaming ? "Viewing image" : "Image viewing pending") : "Viewed image") + (imageName ? " · " + imageName : "")
    : action + " " + detail;
  return (
    <div className="fd-tool-call min-w-0 text-[13px]" data-active={active || undefined} data-kind={viewingImage ? "image" : command ? "command" : "tool"}>
      <button type="button" className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md py-1.5 text-left text-muted hover:text-fg"
        onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={open ? detailsId : undefined} title={use.name + ": " + label}>
        <Icon name={viewingImage ? "image" : command ? "terminal" : "tool"} width={16} height={16} className={cn("shrink-0", error && "text-danger")} />
        <span className="min-w-0 flex-1 truncate"><span className={cn(active && "fd-activity-shimmer")}>{label}</span></span>
        {error && <span className="shrink-0 text-xs text-danger">Error</span>}
        <Icon name={open ? "chevronDown" : "chevronRight"} width={12} height={12} className="shrink-0" />
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
        <div id={detailsId} className="mb-2 ml-6 space-y-2 border-l border-border pl-3 py-2">
          <div className="break-all text-xs text-muted">{use.name}</div>
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
