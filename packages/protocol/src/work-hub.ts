import { z } from "zod/v4";

/**
 * The work hub: what is going on across a GitHub account's repositories (pull requests, issues,
 * commits, who is doing what) and which of it needs the signed-in person. The daemon holds the
 * GitHub token; clients only ever see these shapes.
 */

/** A GitHub login or organization name. */
export const GitHubLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, "Enter a valid GitHub account name");
/** A repository name GitHub would accept as typed (it rewrites other characters to `-`). */
export const GitHubRepoName = z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/, "Use letters, numbers, dots, dashes and underscores");

export const WorkScope = z.enum(["hardware", "all"]);
export type WorkScope = z.infer<typeof WorkScope>;

export type WorkActor = { login: string; avatarUrl: string | null; bot?: boolean };

export type WorkOwner = WorkActor & {
  kind: "user" | "organization";
  /** Whether this account's repositories are scanned for the feed, the attention list and the team view. */
  watched: boolean;
};

export type WorkConnection =
  | { connected: false; reason: "missing" | "invalid" | "offline"; message: string }
  | {
      connected: true;
      /** `token`: saved in fabPlane on this machine. `gh`: borrowed from the GitHub CLI login. */
      source: "token" | "gh";
      viewer: WorkActor & { name: string | null };
      owners: WorkOwner[];
      /** Whether the token may create repositories and push (the `repo` scope, when GitHub reports scopes). */
      canPublish: boolean;
    };

export const UpdateWorkConnection = z.object({
  /** A personal access token to save. Omit to keep the current one. */
  token: z.string().trim().min(20).max(400).regex(/^[A-Za-z0-9_]+$/, "That does not look like a GitHub token").optional(),
  /** Replace the list of watched accounts. */
  watched: z.array(GitHubLogin).max(50).optional(),
}).strict();
export type UpdateWorkConnection = z.infer<typeof UpdateWorkConnection>;

export type WorkRepo = {
  fullName: string;
  owner: string;
  name: string;
  url: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  fork: boolean;
  pushedAt: string | null;
  language: string | null;
  /** True when the repository looks like hardware; `hardwareSignals` says why. */
  hardware: boolean;
  hardwareSignals: string[];
};

export type WorkRepoList = {
  repos: WorkRepo[];
  /** Accounts whose listing was cut off at the per-account limit. */
  truncated: string[];
  fetchedAt: string;
};

export type AttentionReason =
  | "review_requested"
  | "changes_requested"
  | "checks_failing"
  | "merge_conflict"
  | "ready_to_merge"
  | "assigned";

export type AttentionItem = {
  id: string;
  kind: "pull_request" | "issue";
  repo: string;
  number: number;
  title: string;
  url: string;
  author: WorkActor | null;
  draft: boolean;
  updatedAt: string;
  reasons: AttentionReason[];
};

export type WorkEventKind =
  | "commit"
  | "pr_opened"
  | "pr_merged"
  | "pr_closed"
  | "review"
  | "issue_opened"
  | "issue_closed";

export type WorkEvent = {
  id: string;
  kind: WorkEventKind;
  repo: string;
  /** Null when a commit's author is not linked to a GitHub account; `actorName` then has the git name. */
  actor: WorkActor | null;
  actorName?: string;
  /** Commit headline, or the pull request / issue title. */
  title: string;
  /** Pull request or issue number; absent for commits. */
  number?: number;
  /** For reviews: what the reviewer decided. */
  review?: "approved" | "changes_requested" | "commented";
  url: string;
  at: string;
};

export type TeamMember = WorkActor & {
  lastActiveAt: string;
  commits: number;
  pullRequests: number;
  reviews: number;
  issues: number;
  /** Open pull requests this person authored, newest first. */
  openPullRequests: Array<{ repo: string; number: number; title: string; url: string; draft: boolean }>;
  /** The newest thing they did. */
  latest: WorkEvent;
};

export type WorkOverview = {
  scope: WorkScope;
  /** Repositories the feed and team view were built from, most recently pushed first. */
  repos: string[];
  attention: AttentionItem[];
  feed: WorkEvent[];
  team: TeamMember[];
  /** How far back the feed and the team view look. */
  sinceDays: number;
  fetchedAt: string;
};

export const PublishProject = z.object({
  owner: GitHubLogin,
  name: GitHubRepoName,
  private: z.boolean().default(true),
  description: z.string().trim().max(350).optional(),
}).strict();
export type PublishProject = z.input<typeof PublishProject>;

export type ProjectGitHubLink = {
  /** The `origin` remote when it points at github.com. */
  repo: { fullName: string; url: string } | null;
  /** An `origin` that is not GitHub; publishing will not replace it. */
  otherRemote: boolean;
};

const HARDWARE_LANGUAGES = new Set([
  "kicad layout", "kicad schematic", "kicad legacy layout", "eagle", "openscad", "gerber image", "g-code",
  "verilog", "systemverilog", "vhdl", "altium designer", "ltspice symbol", "spice",
]);
const HARDWARE_TOPICS = new Set([
  "hardware", "pcb", "kicad", "electronics", "open-hardware", "open-source-hardware", "oshw", "fpga", "eda",
  "altium", "eagle", "freecad", "openscad", "cad", "3d-printing", "mechanical", "robotics", "embedded", "firmware",
]);
const HARDWARE_FILE = /\.(kicad_pcb|kicad_sch|kicad_pro|kicad_mod|kicad_sym|fcstd|step|stp|scad|brd|pcbdoc|schdoc|prjpcb|f3d|sldprt|sldasm|lbrn2|gbr|ino)$/i;
const HARDWARE_FOLDER = /^(hardware|hw|pcb|pcbs|kicad|gerbers?|cad|mechanical|enclosure|schematics?|boards?|electronics)$/i;

/**
 * Decide whether a repository is hardware from what one listing query returns: languages, topics
 * and the names at the top of the default branch. Deliberately cheap; it reads no file contents.
 */
export function hardwareSignals(repo: {
  languages: readonly string[];
  topics: readonly string[];
  rootEntries: ReadonlyArray<{ name: string; directory: boolean }>;
}): string[] {
  const signals: string[] = [];
  const add = (signal: string) => { if (!signals.includes(signal) && signals.length < 6) signals.push(signal); };
  for (const entry of repo.rootEntries) {
    if (entry.name === "fabdesk.json" && !entry.directory) add("fabPlane project");
    else if (!entry.directory && HARDWARE_FILE.test(entry.name)) add(entry.name);
    else if (entry.directory && HARDWARE_FOLDER.test(entry.name)) add(`${entry.name}/`);
  }
  for (const language of repo.languages) if (HARDWARE_LANGUAGES.has(language.toLowerCase())) add(language);
  for (const topic of repo.topics) if (HARDWARE_TOPICS.has(topic.toLowerCase())) add(`#${topic}`);
  return signals;
}

/** `owner/repo` for a GitHub remote URL (https or ssh), or null for anything else. */
export function gitHubRepoFromRemote(remote: string): { fullName: string; url: string } | null {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!match) return null;
  const fullName = `${match[1]}/${match[2]}`;
  return { fullName, url: `https://github.com/${fullName}` };
}

/** A repository name GitHub will accept, suggested from a project name. */
export function suggestRepoName(projectName: string): string {
  const name = projectName.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100);
  return name || "project";
}
