/** Project-local git commits for Finish it milestones. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GITIGNORE = `# written by fabPlane Finish it
.fabdesk/runs/
.fabdesk/cache/
.fabdesk/revisions/
node_modules/
*.lck
*.bak
*.kicad_prl
`;

export type GitRunner = (
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

async function defaultGit(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_AUTHOR_NAME: env["GIT_AUTHOR_NAME"] ?? "fabPlane",
    GIT_AUTHOR_EMAIL: env["GIT_AUTHOR_EMAIL"] ?? "finish-it@fabplane.local",
    GIT_COMMITTER_NAME: env["GIT_COMMITTER_NAME"] ?? "fabPlane",
    GIT_COMMITTER_EMAIL: env["GIT_COMMITTER_EMAIL"] ?? "finish-it@fabplane.local",
  };
}

export async function ensureProjectGit(
  dir: string,
  run: GitRunner = defaultGit,
): Promise<void> {
  const probe = await run(["rev-parse", "--is-inside-work-tree"], { cwd: dir, env: gitEnv() });
  if (probe.exitCode === 0 && probe.stdout.trim() === "true") return;
  const init = await run(["init"], { cwd: dir, env: gitEnv() });
  if (init.exitCode !== 0)
    throw new Error(`git init failed: ${(init.stderr || init.stdout).trim()}`);
  await writeFile(join(dir, ".gitignore"), GITIGNORE);
}

/**
 * Stage the project and commit. Returns the commit sha, or null when there is nothing to commit.
 */
export async function commitMilestone(
  dir: string,
  message: string,
  run: GitRunner = defaultGit,
): Promise<string | null> {
  await ensureProjectGit(dir, run);
  const env = gitEnv();
  await mkdir(join(dir, ".git"), { recursive: true }).catch(() => undefined);
  const add = await run(["add", "-A"], { cwd: dir, env });
  if (add.exitCode !== 0) throw new Error(`git add failed: ${(add.stderr || add.stdout).trim()}`);
  const staged = await run(["diff", "--cached", "--quiet"], { cwd: dir, env });
  if (staged.exitCode === 0) return null;
  const commit = await run(["commit", "-m", message], { cwd: dir, env });
  if (commit.exitCode !== 0)
    throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
  const sha = await run(["rev-parse", "HEAD"], { cwd: dir, env });
  if (sha.exitCode !== 0) throw new Error(`git rev-parse failed: ${(sha.stderr || sha.stdout).trim()}`);
  return sha.stdout.trim();
}
