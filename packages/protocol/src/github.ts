/** Shared by the project dialog and daemon so validation and suggested names agree. */
export function parsePublicGitHubUrl(input: string): { url: string; owner: string; repo: string } {
  let parsed: URL;
  try { parsed = new URL(input.trim()); }
  catch { throw new Error("Enter a public GitHub repository URL"); }
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !match) {
    throw new Error("Use a public https://github.com/owner/repo URL without credentials or extra paths");
  }
  const owner = match[1]!;
  const repo = match[2]!;
  if (owner.startsWith("-") || owner.endsWith("-") || repo.startsWith(".")) {
    throw new Error("Enter a valid GitHub owner and repository");
  }
  return { url: `https://github.com/${owner}/${repo}.git`, owner, repo };
}
