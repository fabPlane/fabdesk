import { ToolError } from "@fabdesk/tools";
import { parsePublicGitHubUrl as parse } from "@fabdesk/protocol";

/** Public GitHub repository URLs only; never pass credentials or arbitrary hosts to git. */
export function parsePublicGitHubUrl(input: string): { url: string; owner: string; repo: string } {
  try { return parse(input); }
  catch (error) { throw new ToolError(error instanceof Error ? error.message : String(error), "invalid_args"); }
}
