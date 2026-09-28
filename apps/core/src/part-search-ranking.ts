/** Deterministic, field-aware matching for KiCad library identifiers and metadata. */

export type PartSearchCandidate<T = unknown> = {
  libId: string;
  nickname: string;
  name: string;
  description?: string | undefined;
  keywords?: string | string[] | undefined;
  value?: T;
};

export type RankedPartSearchCandidate<T = unknown> = PartSearchCandidate<T> & {
  score: number;
  matchedTokens: number;
  allTokensMatched: boolean;
  allTokensMatchedInName: boolean;
};

const LOW_INFORMATION_TERMS = new Set([
  "component",
  "item",
  "mount",
  "mounting",
  "package",
  "pad",
  "part",
  "pin",
  "size",
  "type",
]);

function canonicalToken(token: string): string {
  if (/^\d+(?:\.\d+)?$/.test(token)) {
    const numeric = Number(token);
    if (Number.isFinite(numeric)) return String(numeric);
  }
  // A small morphology rule makes package prose ("pins") match the usual singular query without
  // carrying an electronics-category synonym list.
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function partSearchTokens(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .toLocaleLowerCase("en-US")
      .match(/\p{L}+|\d+(?:\.\d+)?/gu) ?? []
  ).map(canonicalToken);
}

function phrase(value: string): string {
  return partSearchTokens(value).join(" ");
}

function keywordText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(" ") : (value ?? "");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tokenMatch(query: string, candidate: string): number {
  if (query === candidate) return 2;
  if (query.length >= 3 && candidate.startsWith(query)) return 1;
  if (candidate.length >= 3 && query.startsWith(candidate)) return 1;
  return 0;
}

function bestMatch(query: string, tokens: string[]): number {
  let best = 0;
  for (const token of tokens) best = Math.max(best, tokenMatch(query, token));
  return best;
}

export function rankPartSearchCandidate<T>(
  query: string,
  candidate: PartSearchCandidate<T>,
): RankedPartSearchCandidate<T> {
  const queryTokens = [...new Set(partSearchTokens(query))];
  const hasNumericQuery = queryTokens.some((token) => /^\d/.test(token));
  const meaningfulQueryTokens = queryTokens.filter((token) => !LOW_INFORMATION_TERMS.has(token));
  if (!meaningfulQueryTokens.length) meaningfulQueryTokens.push(...queryTokens);
  const libraryTokens = partSearchTokens(candidate.nickname);
  const itemTokens = partSearchTokens(candidate.name);
  const metadataTokens = partSearchTokens(
    `${candidate.description ?? ""} ${keywordText(candidate.keywords)}`,
  );
  const strongTokens = [...libraryTokens, ...itemTokens];
  const allTokens = [...strongTokens, ...metadataTokens];

  let matchedTokens = 0;
  let exactTokenMatches = 0;
  let strongTokenMatches = 0;
  let itemTokenMatches = 0;
  let metadataTokenMatches = 0;
  let weightedCoverage = 0;
  for (const token of queryTokens) {
    const item = bestMatch(token, itemTokens);
    const library = bestMatch(token, libraryTokens);
    const metadata = bestMatch(token, metadataTokens);
    const best = Math.max(item, library, metadata);
    if (!best) continue;
    matchedTokens++;
    const lowInformation =
      LOW_INFORMATION_TERMS.has(token) && meaningfulQueryTokens.length < queryTokens.length;
    // In "2 pin", the normalized numeric/dimensional token carries the discriminating package
    // information. Without a numeric token, words such as "mounting" still refine the request.
    if (lowInformation && hasNumericQuery) continue;
    if (best === 2) exactTokenMatches++;
    if (item) itemTokenMatches++;
    if (item || library) strongTokenMatches++;
    if (metadata) metadataTokenMatches++;
    weightedCoverage += (lowInformation ? 1 : 3) * best;
  }

  const allTokensMatched = queryTokens.length > 0 && matchedTokens === queryTokens.length;
  const allMeaningfulTokensMatched = meaningfulQueryTokens.every(
    (token) => bestMatch(token, allTokens) > 0,
  );
  const allTokensMatchedInName = meaningfulQueryTokens.every(
    (token) => bestMatch(token, strongTokens) > 0,
  );
  const queryPhrase = phrase(query);
  const itemPhrase = phrase(candidate.name);
  const idPhrase = phrase(candidate.libId);
  const libraryPhrase = phrase(candidate.nickname);
  const metadataPhrase = phrase(
    `${candidate.description ?? ""} ${keywordText(candidate.keywords)}`,
  );
  const descriptionPhrase = phrase(candidate.description ?? "");
  const exactId = queryPhrase.length > 0 && queryPhrase === idPhrase;
  const exactItem = queryPhrase.length > 0 && queryPhrase === itemPhrase;
  const exactLibrary = queryPhrase.length > 0 && queryPhrase === libraryPhrase;
  const itemPrefix = queryPhrase.length > 0 && itemPhrase.startsWith(queryPhrase);
  const exactMetadata = queryPhrase.length > 0 && metadataPhrase === queryPhrase;
  const extraNameTokens = Math.max(0, new Set(strongTokens).size - strongTokenMatches);

  // Large tier gaps make the policy explicit: identity, then complete strong-name coverage, then
  // complete metadata-assisted coverage, then partial discovery. The final compactness terms only
  // order candidates within a tier; libId is the stable final tie-breaker in rankPartSearch().
  const score =
    (exactId ? 1_000_000_000 : 0) +
    (exactItem ? 500_000_000 : 0) +
    (itemPrefix ? 100_000_000 : 0) +
    (allTokensMatchedInName ? 20_000_000 : 0) +
    (allMeaningfulTokensMatched ? 5_000_000 : 0) +
    (exactLibrary ? 1_000_000 : 0) +
    (queryPhrase === descriptionPhrase ? 500_000 : 0) +
    weightedCoverage * 10_000 +
    exactTokenMatches * 2_000 +
    itemTokenMatches * 1_000 +
    strongTokenMatches * 500 +
    metadataTokenMatches * 25 +
    (exactMetadata ? 100 : 0) -
    extraNameTokens * 10 -
    strongTokens.length;

  return { ...candidate, score, matchedTokens, allTokensMatched, allTokensMatchedInName };
}

export function rankPartSearch<T>(
  query: string,
  candidates: PartSearchCandidate<T>[],
): RankedPartSearchCandidate<T>[] {
  return candidates
    .map((candidate) => rankPartSearchCandidate(query, candidate))
    .filter((candidate) => candidate.matchedTokens > 0)
    .sort((a, b) => b.score - a.score || compareText(a.libId, b.libId));
}
