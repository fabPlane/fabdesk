/** Names a "New chat" after its first message: the opening clause, cut at a word, never mid-token. */
const MAX = 60;
const MIN_CLAUSE = 12;

export function threadTitleFrom(content: string): string {
  const flat = content.trim().replace(/\s+/g, " ");
  if (flat.length <= MAX) return flat;
  // The first clause usually says what the chat is about ("Design a PS1 serial dev dongle: ...").
  const clause = flat.match(/^(.{12,60}?)(?:[:;.!?]|\s[-–—]\s|\n)/u)?.[1]?.trim();
  if (clause && clause.length >= MIN_CLAUSE) return clause;
  const cut = flat.slice(0, MAX);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord >= MIN_CLAUSE ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}
