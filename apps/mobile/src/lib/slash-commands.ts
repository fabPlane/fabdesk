/**
 * Slash commands in the composer: `/render top`, `/route`, `/drc`, `/erc`, `/export gerbers`,
 * `/build`. They run a tool directly (`useRunTool`), never through the agent, and only in a thread
 * that has a project — the tools all act on a board. Pure, so Bun tests it; the popover and the
 * toast are the thread screen's.
 *
 * Tool names: the kinds `build` / `route` / `drc` / `erc` / `render` resolve through
 * `resolveToolName` against the manifest; the exports are spelled out (`export_gerbers`, …).
 */

export interface SlashCommandSpec {
  /** Without the slash. */
  name: string;
  /** Shown in the popover: `/render [top|bottom]`. */
  usage: string;
  description: string;
  /** Allowed first argument; `null` means the command takes none. */
  choices: readonly string[] | null;
  /** When `choices` is set and none is typed. `null` means an argument is required. */
  defaultChoice: string | null;
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    name: "render",
    usage: "/render [top|bottom]",
    description: "Render the board to a PNG",
    choices: ["top", "bottom"],
    defaultChoice: "top",
  },
  {
    name: "route",
    usage: "/route",
    description: "Autoroute the board",
    choices: null,
    defaultChoice: null,
  },
  { name: "drc", usage: "/drc", description: "Run KiCad DRC", choices: null, defaultChoice: null },
  { name: "erc", usage: "/erc", description: "Run KiCad ERC", choices: null, defaultChoice: null },
  {
    name: "export",
    usage: "/export gerbers|bom|drill|pos|zip|stencil|laser_stencil",
    description: "Export fabrication files",
    choices: ["gerbers", "bom", "drill", "pos", "zip", "stencil", "laser_stencil"],
    defaultChoice: null,
  },
  {
    name: "build",
    usage: "/build",
    description: "Build board.kicad_pcb from the netlist",
    choices: null,
    defaultChoice: null,
  },
];

/** A ready-to-run command: what to call and what to say while it runs. */
export interface SlashCommand {
  name: string;
  arg: string | null;
  /** `useRunTool` kind (`render`, `route`, …) or a literal tool name (`export_gerbers`). */
  tool: string;
  args: Record<string, unknown>;
  /** Canonical text, e.g. `/render top`. */
  text: string;
  /** Progress line: "Rendering top…". */
  progressLabel: string;
  /** Result line: "Rendered top". */
  doneLabel: string;
}

export type SlashParse =
  | { ok: true; command: SlashCommand }
  | { ok: false; error: string; partial: boolean };

/** Composer text that is (or is becoming) a slash command: one line, starting with `/`. */
export function isSlashDraft(text: string): boolean {
  return text.startsWith("/") && !text.includes("\n");
}

function tokens(text: string): string[] {
  return text.trim().slice(1).split(/\s+/).filter(Boolean);
}

function build(spec: SlashCommandSpec, arg: string | null): SlashCommand {
  const text = arg ? `/${spec.name} ${arg}` : `/${spec.name}`;
  switch (spec.name) {
    case "render":
      return {
        name: spec.name,
        arg,
        tool: "render",
        args: { view: arg ?? "top" },
        text,
        progressLabel: `Rendering ${arg ?? "top"}…`,
        doneLabel: `Rendered ${arg ?? "top"}`,
      };
    case "route":
      return {
        name: spec.name,
        arg,
        tool: "route",
        args: {},
        text,
        progressLabel: "Routing…",
        doneLabel: "Routed",
      };
    case "drc":
      return {
        name: spec.name,
        arg,
        tool: "drc",
        args: {},
        text,
        progressLabel: "Running DRC…",
        doneLabel: "DRC finished",
      };
    case "erc":
      return {
        name: spec.name,
        arg,
        tool: "erc",
        args: {},
        text,
        progressLabel: "Running ERC…",
        doneLabel: "ERC finished",
      };
    case "export":
      return {
        name: spec.name,
        arg,
        tool: `export_${arg}`,
        args: {},
        text,
        progressLabel: `Exporting ${arg}…`,
        doneLabel: `Exported ${arg}`,
      };
    case "build":
      return {
        name: spec.name,
        arg,
        tool: "build",
        args: {},
        text,
        progressLabel: "Building…",
        doneLabel: "Built",
      };
    default:
      throw new Error(`unknown slash command ${spec.name}`);
  }
}

/** Parses a finished command. `partial` in the error means more typing could still fix it. */
export function parseSlashCommand(text: string): SlashParse {
  if (!isSlashDraft(text)) return { ok: false, error: "Not a slash command", partial: false };
  const [name, arg, ...rest] = tokens(text);
  if (!name) return { ok: false, error: "Type a command", partial: true };
  const spec = SLASH_COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!spec) {
    const partial = SLASH_COMMANDS.some((c) => c.name.startsWith(name.toLowerCase()));
    return { ok: false, error: `Unknown command /${name}`, partial };
  }
  if (rest.length > 0)
    return { ok: false, error: `${spec.usage} takes one argument`, partial: false };
  if (spec.choices === null) {
    if (arg) return { ok: false, error: `${spec.usage} takes no argument`, partial: false };
    return { ok: true, command: build(spec, null) };
  }
  if (!arg) {
    if (spec.defaultChoice) return { ok: true, command: build(spec, spec.defaultChoice) };
    return { ok: false, error: `Pick one: ${spec.choices.join(", ")}`, partial: true };
  }
  const choice = spec.choices.find((c) => c === arg.toLowerCase());
  if (!choice) {
    const partial = spec.choices.some((c) => c.startsWith(arg.toLowerCase()));
    return { ok: false, error: `${spec.usage}: not "${arg}"`, partial };
  }
  return { ok: true, command: build(spec, choice) };
}

export interface SlashSuggestion {
  /** What tapping inserts and runs. */
  command: SlashCommand;
  usage: string;
  description: string;
}

/**
 * What the popover lists for the current draft: every command whose name starts with what was
 * typed; once the name is complete, its argument choices filtered the same way. An empty `/`
 * lists everything. Commands with a default argument list that variant first.
 */
export function slashSuggestions(text: string): SlashSuggestion[] {
  if (!isSlashDraft(text)) return [];
  const [name = "", arg = "", ...rest] = tokens(text);
  if (rest.length > 0) return [];
  const lower = name.toLowerCase();
  const exact = SLASH_COMMANDS.find((c) => c.name === lower);
  const endedName = text.trimStart().slice(1).includes(" ");
  if (exact && (endedName || exact.choices === null)) {
    if (exact.choices === null)
      return arg
        ? []
        : [{ command: build(exact, null), usage: exact.usage, description: exact.description }];
    return exact.choices
      .filter((c) => c.startsWith(arg.toLowerCase()))
      .map((c) => ({
        command: build(exact, c),
        usage: `/${exact.name} ${c}`,
        description:
          c === exact.defaultChoice ? `${exact.description} (default)` : exact.description,
      }));
  }
  if (arg) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(lower)).map((c) => ({
    command: build(c, c.defaultChoice),
    usage: c.usage,
    description: c.description,
  }));
}

/** The toast under the composer; `jobsHint` invites a tap through to the Jobs screen. */
export function slashToast(
  command: SlashCommand,
  state: { status: "idle" | "running" | "done" | "failed"; error?: string | undefined },
): { text: string; tone: "muted" | "success" | "danger"; jobsHint: boolean } | null {
  switch (state.status) {
    case "running":
      return { text: `${command.progressLabel} · watch in Jobs`, tone: "muted", jobsHint: true };
    case "done":
      return { text: `${command.doneLabel} ✓`, tone: "success", jobsHint: true };
    case "failed":
      return {
        text: `${command.text} failed${state.error ? `: ${firstLine(state.error)}` : ""}`,
        tone: "danger",
        jobsHint: true,
      };
    default:
      return null;
  }
}

/** Why the popover cannot offer anything for this thread, or null when it can. */
export function slashBlockedReason(
  thread: { projectId: string | null } | undefined,
): string | null {
  if (!thread) return "Loading the chat…";
  if (!thread.projectId) return "Slash commands act on a board; this chat has no project.";
  return null;
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/, 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
