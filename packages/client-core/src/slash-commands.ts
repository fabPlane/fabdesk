/**
 * Composer slash commands, expanded client-side into the message the agent receives.
 * `/shopping-list [text]` asks the agent to manage the project's fabplane shopping list.
 */
export type SlashCommand = { name: string; usage: string; hint: string };

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "shopping-list",
    usage: "/shopping-list [request]",
    hint: "Manage this project's fabplane shopping list and inventory with the shopping tools",
  },
];

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

/** The expanded message for a slash command, or null when `text` is not one. */
export function expandSlashCommand(text: string): string | null {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const rest = (m[2] ?? "").trim();
  switch (m[1]) {
    case "shopping-list":
      return shoppingListPrompt(rest);
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
