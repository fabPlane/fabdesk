/**
 * A board that has just been built or updated from a circuit is both a design and a layout job: the circuit tools
 * stay, and the `board` toolset (acceptance checks, edits, release, durable jobs) is switched on for the session
 * instead of waiting for the agent to find `load_toolset`.
 */
import type { ToolDef, ToolOutput } from "../registry";

export const BOARD_HANDOFF_TOOLS: ReadonlySet<string> = new Set(["circuit_build", "pcb_update_from_schematic"]);

export const BOARD_HANDOFF_NOTE =
  "Board toolset loaded for this session: board_job waits for, reports or cancels long board jobs; the board workflow tools in this set are listed by load_toolset.";

export function withBoardHandoff<T extends ToolDef>(tool: T): T {
  if (!BOARD_HANDOFF_TOOLS.has(tool.name)) return tool;
  const inner = tool.handler as (input: never, ctx: Parameters<T["handler"]>[1]) => Promise<ToolOutput>;
  const handler = (async (input: never, ctx: Parameters<T["handler"]>[1]) => {
    const out = await inner(input, ctx);
    if (out.isError || !ctx.session) return out;
    if (ctx.session.enabledToolsets().includes("board")) return out;
    ctx.session.enableToolset("board");
    return { ...out, text: `${out.text ?? ""}${out.text ? "\n\n" : ""}${BOARD_HANDOFF_NOTE}` };
  }) as unknown as T["handler"];
  return { ...tool, handler };
}
