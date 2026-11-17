import { schematicFocusChoicesFromResult, schematicFocusFromResult, useRunTool, useCoreClient } from "@fabdesk/client-core";
import type { SchematicFocus, SchematicFocusChoices } from "@fabdesk/protocol";
import { Button } from "../components/ui";
import type { MessagePart } from "@fabdesk/protocol";
import { useId, useState } from "react";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { cn, isImagePath, stringifyPretty } from "../util";
import { ProjectImage } from "./ProjectImage";
import { ErrorNotice } from "../components/ErrorNotice";

type ToolUse = Extract<MessagePart, { type: "tool_use" }>;
type ToolResult = Extract<MessagePart, { type: "tool_result" }>;

export interface ExtractedImage {
  kind: "data" | "path";
  src: string;
  mime?: string;
}

/** Finds images in a tool result: MCP content blocks, `{type:"image"}` objects, or image file paths. */
export function extractImages(output: unknown, depth = 0, includeInspection = false, inherited?: string): ExtractedImage[] {
  if (depth > 8 || output === null || output === undefined || inherited === "inspection" && !includeInspection) return [];
  if (typeof output === "string") {
    if (output.startsWith("data:image/")) return [{ kind: "data", src: output }];
    if (isImagePath(output) && !output.includes("\n") && output.length < 400) return [{ kind: "path", src: output }];
    return [];
  }
  if (Array.isArray(output)) return output.flatMap((o) => extractImages(o, depth + 1, includeInspection, inherited));
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    const meta = o["_meta"] as Record<string, unknown> | undefined;
    const presentation = o["_imagePresentation"] ?? o["imagePresentation"] ?? meta?.["fabplane/imagePresentation"] ?? inherited;
    if (presentation === "inspection" && !includeInspection) return [];
    if (o["type"] === "image" && typeof o["data"] === "string") {
      const mime = typeof o["mimeType"] === "string" ? o["mimeType"] : "image/png";
      return [{ kind: "data", src: `data:${mime};base64,${o["data"]}`, mime }];
    }
    if (o["type"] === "image" && typeof o["path"] === "string") return [{ kind: "path", src: o["path"] }];
    const out: ExtractedImage[] = [];
    for (const key of ["content", "result", "structuredContent", "json", "output", "images", "image", "path", "png", "svg", "outputs", "files"]) {
      if (key in o) out.push(...extractImages(o[key], depth + 1, includeInspection, typeof presentation === "string" ? presentation : inherited));
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

function ShowSchematicComponent({ focus }: { focus: SchematicFocus }) {
  const client = useCoreClient(), [notice, setNotice] = useState<string | null>(null);
  return <div className="px-2.5 pb-2"><Button size="sm" onClick={() => {
    const request = { ...focus, id: crypto.randomUUID(), requestedAt: Date.now() }, ui = useUiStore.getState();
    void client.inspectBoardSources(request.projectId).then(sources => {
      ui.requestSchematicFocus(request, client.baseUrl, sources);
      setNotice(useUiStore.getState().schematicFocus?.focus.id === request.id ? null : "The source changed or this workspace has an unfinished edit. Recheck the board before showing this component.");
    }).catch(() => setNotice("Could not verify this board’s current source. Try again when connected."));
  }}><Icon name="search" width={15} height={15} />Show {focus.reference} on schematic</Button>{notice && <p role="status" className="text-xs text-muted">{notice}</p>}</div>;
}

function ChooseSchematicSheet({ choices }: { choices: SchematicFocusChoices }) {
  const tool = useRunTool(), client = useCoreClient();
  const [notice, setNotice] = useState<string | null>(null);
  return <section className="px-2.5 pb-2" aria-label="Choose schematic sheet">
    <p className="mb-2 text-xs text-muted">{choices.reference} appears in more than one sheet. Which instance do you mean?</p>
    <div className="flex max-h-48 flex-col gap-2 overflow-auto">{choices.sheets.map(sheet => <Button key={sheet.identity} size="sm" disabled={tool.state.status === "running"} title={sheet.sourcePath} onClick={() => {
      if (useUiStore.getState().activeProjectId !== choices.projectId) return;
      setNotice(null);
      void tool.run("schematic_focus", { projectId: choices.projectId, reference: choices.reference, sheetIdentity: sheet.identity, expectedHierarchyRevision: choices.expectedHierarchyRevision, ...(choices.board ? { board: choices.board } : {}) }).then(async result => {
        if (result.status !== "done") return;
        const focus = schematicFocusFromResult(result.result);
        if (!focus) { setNotice("This sheet could not be focused. Locate the component again after checking its source."); return; }
        const sources = await client.inspectBoardSources(choices.projectId);
        useUiStore.getState().requestSchematicFocus(focus, client.baseUrl, sources);
      }).catch(() => setNotice("Could not recheck the current board source. Try again when connected."));
    }}><Icon name="schematic" width={15} height={15} />{sheet.hierarchyPath} · {sheet.sourcePath}</Button>)}</div>
    {(notice || tool.state.error) && <p role="status" className="mt-2 text-xs text-muted">{notice ?? tool.state.error}</p>}
  </section>;
}

export function ToolCallCard({ use, result, streaming = false }: { use: ToolUse; result?: ToolResult | undefined; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const projectId = useUiStore((s) => s.activeProjectId);
  const pending = !result;
  const error = result?.isError === true;
  const images = result ? extractImages(result.output, 0, open) : [];
  const command = isCommandTool(use.name);
  const viewingImage = isImageTool(use.name);
  const active = pending && streaming;
  const name = use.name.replace(/^mcp__.+?__/, "");
  const action = error ? "Failed" : pending ? (streaming ? "Running" : "Pending") : command ? "Ran" : "Used";
  const detail = command ? commandText(use.input) || name : [name, summarizeArgs(use.input)].filter(Boolean).join(" · ");
  const imageName = imagePath(use.input);
  const focusTool = name === "schematic_focus" || name === "capability_call" && !!use.input && typeof use.input === "object" && (use.input as Record<string, unknown>).name === "schematic_focus";
  const choices = result && !error && focusTool ? schematicFocusChoicesFromResult(result.output) : null;
  const focus = result && !error && focusTool ? schematicFocusFromResult(result.output) : null;
  const label = viewingImage
    ? (error ? "Could not view image" : pending ? (streaming ? "Viewing image" : "Image viewing pending") : "Viewed image") + (imageName ? " · " + imageName : "")
    : action + " " + detail;
  return (
    <div className="fd-tool-call min-w-0 text-[13px]" data-active={active || undefined} data-kind={viewingImage ? "image" : command ? "command" : "tool"}>
      <button type="button" className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md py-1.5 text-left text-fg hover:bg-panel-2/70"
        onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={open ? detailsId : undefined} title={use.name + ": " + label}>
        <Icon name={viewingImage ? "image" : command ? "terminal" : "tool"} width={16} height={16} className={cn("shrink-0", error && "text-danger")} />
        <span className="min-w-0 flex-1 truncate"><span className={cn(active && "fd-activity-shimmer")}>{label}</span></span>
        {error && <span className="shrink-0 text-xs text-danger">Error</span>}
        <Icon name={open ? "chevronDown" : "chevronRight"} width={12} height={12} className="shrink-0" />
      </button>
      {choices?.projectId === projectId && <ChooseSchematicSheet choices={choices} />}
      {focus?.projectId === projectId && <ShowSchematicComponent focus={focus} />}
      {error && result && <ErrorNotice error={resultText(result.output)} />}
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
