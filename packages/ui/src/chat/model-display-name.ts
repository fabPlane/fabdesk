/** Display-only labels. Selection and requests always keep the original model ID. */
export function modelDisplayName(id: string): string {
  if (/^(auto|fable|opus|sonnet|haiku)$/.test(id)) return id[0]!.toUpperCase() + id.slice(1);
  if (/^(gpt|grok)-\d/.test(id)) {
    return id.replace(/^gpt/, "GPT").replace(/^grok/, "Grok").replace(/-(sol|terra|luna|astra)$/, (_, name: string) => ` ${name[0]!.toUpperCase()}${name.slice(1)}`);
  }
  if (/^(opus|sonnet|haiku)-\d/.test(id)) return id[0]!.toUpperCase() + id.slice(1).replace("-", " ");
  return id;
}
