/** Display-only labels. Selection and requests always keep the original model ID. */
export function modelDisplayName(id: string, aliases?: Record<string, string>): string {
  const resolved = aliases?.[id] ?? id;
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(resolved);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}${claude[4] ? " (1M)" : ""}`;
  id = resolved;
  if (/^(auto|fable|opus|sonnet|haiku)$/.test(id)) return id[0]!.toUpperCase() + id.slice(1);
  if (/^(gpt|grok)-\d/.test(id)) {
    return id.replace(/^gpt/, "GPT").replace(/^grok/, "Grok").replace(/-(sol|terra|luna|astra)$/, (_, name: string) => ` ${name[0]!.toUpperCase()}${name.slice(1)}`);
  }
  if (/^(opus|sonnet|haiku|fable)-\d/.test(id)) return id[0]!.toUpperCase() + id.slice(1).replace("-", " ");
  return id;
}
