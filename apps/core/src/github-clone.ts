/**
 * Clone a GitHub repository for import. Public repositories clone anonymously, exactly as before.
 * When that is refused and GitHub is connected (Home › Work), the clone is tried once more with
 * the connection's token, so a private repository the person can see imports the same way.
 */
import { mkdir, rm } from "node:fs/promises";
import { defaultGitClone, gitMissingFromClone } from "./projects";

type Clone = typeof defaultGitClone;

/** What git says when a repository is private, missing, or needs a login it was not given. */
const NEEDS_LOGIN = /repository not found|authentication failed|could not read username|terminal prompts disabled|access denied|HTTP 40[134]|error: 40[134]/i;

export async function cloneGitHubRepository(opts: {
  url: string;
  dir: string;
  signal?: AbortSignal | undefined;
  /** Git environment carrying the GitHub connection, or null when GitHub is not connected. */
  authEnv: () => Promise<NodeJS.ProcessEnv | null>;
  clone?: Clone;
}): Promise<{ authenticated: boolean }> {
  const clone = opts.clone ?? defaultGitClone;
  try {
    await clone(opts.url, opts.dir, opts.signal);
    return { authenticated: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.signal?.aborted || gitMissingFromClone(error) || !NEEDS_LOGIN.test(message)) throw error;
    const env = await opts.authEnv();
    if (!env) throw new Error("GitHub did not allow reading this repository. If it is private, connect GitHub under Home › Work, then import again.");
    // The refused clone may have left a partial folder behind; start the second try clean.
    await rm(opts.dir, { recursive: true, force: true });
    await mkdir(opts.dir);
    try {
      await clone(opts.url, opts.dir, opts.signal, { env, full: true });
    } catch (retry) {
      if (opts.signal?.aborted) throw retry;
      const detail = retry instanceof Error ? retry.message : String(retry);
      throw new Error(NEEDS_LOGIN.test(detail)
        ? "Your GitHub connection cannot read this repository. Check the address, and that the connected account has access to it."
        : detail);
    }
    return { authenticated: true };
  }
}
