import { ToolError } from "@fabdesk/tools";

/** Public GitHub repository URLs only; never pass credentials or arbitrary hosts to git. */
export function parsePublicGitHubUrl(input: string): { url: string; owner: string; repo: string } {
  let parsed: URL;
  try { parsed = new URL(input.trim()); }
  catch { throw new ToolError("Enter a public GitHub repository URL", "invalid_args"); }
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !match) {
    throw new ToolError("Use a public https://github.com/owner/repo URL without credentials or extra paths", "invalid_args");
  }
  const owner = match[1]!;
  const repo = match[2]!;
  if (owner.startsWith("-") || owner.endsWith("-") || repo === "." || repo === ".." || repo.startsWith(".")) {
    throw new ToolError("Enter a valid GitHub owner and repository", "invalid_args");
  }
  return { url: `https://github.com/${owner}/${repo}.git`, owner, repo };
}
