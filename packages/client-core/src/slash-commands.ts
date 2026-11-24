/**
 * Composer slash commands, expanded client-side into the message the agent receives.
 * `/shopping-list [text]` asks the agent to manage the project's fabplane shopping list.
 */
export type SlashCommand = { name: string; usage: string; hint: string };

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "parts",
    usage: "/parts [request]",
    hint: "Add off-board motors, displays, standoffs or screws to this project's BOM",
  },
  {
    name: "shopping-list",
    usage: "/shopping-list [request]",
    hint: "Manage this project's fabplane shopping list and inventory with the shopping tools",
  },
  {
    name: "finish-it",
    usage: "/finish-it",
    hint: "Let the agent finish schematic, place, route and verify without step-by-step prompts",
  },
  {
    name: "photo",
    usage: "/photo [request]",
    hint: "Draft an editable board from photos in this chat or sketches/",
  },
];

function partsPrompt(request: string): string {
  return [
    "Use the fabdesk `project` MCP tools to manage this project's off-board parts (motors, displays, standoffs, screws and similar hardware that is not placed on the PCB).",
    'Load them with load_toolset {"toolset":"project"}.',
    "Tools: parts_search (library), parts_add (catalogId from search, or name + kind), parts_list (project BOM: electrical + off-board), parts_remove.",
    "Do not put off-board hardware in the electrical netlist. End with the updated BOM.",
    request
      ? `Request: ${request}`
      : "Request: search the off-board library for the hardware this project needs and add it so the BOM lists it next to the board parts.",
  ].join("\n");
}

function photoPrompt(request: string): string {
  return [
    "Use the fabdesk core tools photo_analyze and photo_to_project.",
    "1) Copy any attached photos into sketches/ if they are not already there.",
    "2) Call photo_analyze with those paths and a what-I-see list (you can read the photos yourself and pass items).",
    "3) Show the user the table and scale assumption, wait for corrections, then call photo_to_project.",
    "Do not copy traces pixel-by-pixel. Draft a working functional equivalent and say so.",
    "If the photos look like a known open-source design, mention attribution and never claim the draft is that design.",
    request
      ? `Request: ${request}`
      : "Request: draft a board from the attached or sketched photos.",
  ].join("\n");
}

function shoppingListPrompt(request: string): string {
  return [
    "Use the fabdesk `shopping` MCP tools to manage this project's fabplane.com shopping list.",
    'Load them with load_toolset {"toolset":"shopping"} (or capability_search "shopping list" + capability_call when load_toolset is not offered).',
    "Tools: shopping_list_get, shopping_list_sync_bom, shopping_list_add, shopping_list_update, shopping_list_remove, shopping_list_destinations, inventory_search, inventory_add.",
    "Check inventory_search for parts the team already has. End with a short summary grouped by destination and the dashboard link.",
    request
      ? `Request: ${request}`
      : "Request: show the current shopping list, sync it from the BOM if it is missing or stale, and point out anything that needs a decision.",
  ].join("\n");
}

/** True when the composer should start Finish it instead of sending a chat turn. */
export function isFinishItCommand(text: string): boolean {
  return /^\/finish-it(?:\s.*)?$/.test(text.trim());
}

/** The expanded message for a slash command, or null when `text` is not one. */
export function expandSlashCommand(text: string): string | null {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const rest = (m[2] ?? "").trim();
  switch (m[1]) {
    case "parts":
      return partsPrompt(rest);
    case "shopping-list":
      return shoppingListPrompt(rest);
    case "finish-it":
      return null;
    case "photo":
      return photoPrompt(rest);
    default:
      return null;
  }
}

/** Commands whose name starts with what the user typed after `/` (no argument yet). */
export function slashSuggestions(text: string): SlashCommand[] {
  const m = /^\/([a-z0-9-]*)$/.exec(text.trimStart());
  if (!m) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(m[1] ?? ""));
}
