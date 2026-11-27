/**
 * The work hub's GitHub side: one token on this machine, GitHub's GraphQL API, and short-lived
 * caches. Nothing here is pushed to fabplane.com, and the token never leaves the daemon.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  gitHubRepoFromRemote,
  hardwareSignals,
  type AttentionItem,
  type AttentionReason,
  type ProjectGitHubLink,
  type TeamMember,
  type UpdateWorkConnection,
  type WorkActor,
  type WorkConnection,
  type WorkEvent,
  type WorkOverview,
  type WorkOwner,
  type WorkRepo,
  type WorkRepoList,
  type WorkScope,
} from "@fabdesk/protocol";
import { commitMilestone, defaultGit, type GitRunner } from "./finish-it-git";

const API = "https://api.github.com";
/** Repositories listed per watched account (four pages of 50, most recently pushed first). */
const REPOS_PER_OWNER = 200;
/** Repositories whose activity builds the feed and the team view. */
const ACTIVE_REPOS = 20;
const ACTIVITY_BATCH = 4;
const SINCE_DAYS = 14;
const FEED_LIMIT = 200;

export type WorkHubErrorCode =
  | "github_not_connected"
  | "github_token_invalid"
  | "github_offline"
  | "github_rate_limited"
  | "github_error"
  | "already_published"
  | "other_remote"
  | "repo_exists"
  | "cannot_publish"
  | "push_failed";

export class WorkHubError extends Error {
  constructor(readonly code: WorkHubErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = "WorkHubError";
  }
}

type Saved = { token?: string; watched?: string[] };
type Credential = { token: string; source: "token" | "gh" };

export type WorkHubOptions = {
  /** The fabPlane data folder; the token is kept in `github.json` inside it (0600). */
  home: string;
  fetch?: typeof fetch;
  /** The GitHub CLI's token, or null when `gh` is missing or signed out. */
  ghToken?: () => Promise<string | null>;
  git?: GitRunner;
  now?: () => number;
};

async function ghCliToken(): Promise<string | null> {
  try {
    const child = Bun.spawn(["gh", "auth", "token", "--hostname", "github.com"], {
      stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true,
    });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const token = out.trim();
    return code === 0 && /^[A-Za-z0-9_]{20,400}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

type Cached<T> = { at: number; key: string; value: Promise<T> };

type Actor = { __typename?: string; login: string; avatarUrl?: string | null } | null | undefined;

function actor(a: Actor): WorkActor | null {
  if (!a?.login) return null;
  const bot = a.__typename === "Bot" || a.login.endsWith("[bot]");
  return { login: a.login, avatarUrl: a.avatarUrl ?? null, ...(bot ? { bot: true } : {}) };
}

const REASON_ORDER: AttentionReason[] = [
  "review_requested", "changes_requested", "checks_failing", "merge_conflict", "ready_to_merge", "assigned",
];

type RepoNode = {
  nameWithOwner: string; name: string; owner: { login: string }; url: string; description: string | null;
  isPrivate: boolean; isArchived: boolean; isFork: boolean; pushedAt: string | null;
  primaryLanguage: { name: string } | null;
  languages: { nodes: Array<{ name: string }> } | null;
  repositoryTopics: { nodes: Array<{ topic: { name: string } }> } | null;
  object: { entries?: Array<{ name: string; type: string }> } | null;
};

type RepoConnection = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<RepoNode | null> };
type RepoPage = { repositoryOwner: { repositories: RepoConnection } | null };

type SearchPr = {
  __typename: "PullRequest" | "Issue"; number: number; title: string; url: string; updatedAt: string;
  isDraft?: boolean; repository: { nameWithOwner: string }; author: Actor;
  reviewDecision?: string | null; mergeable?: string | null;
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
};

type ActivityRepo = {
  nameWithOwner: string;
  defaultBranchRef: { target: { history?: { nodes: Array<{
    oid: string; messageHeadline: string; committedDate: string; url: string;
    author: { name: string | null; user: Actor } | null;
  }> } } | null } | null;
  pullRequests: { nodes: Array<{
    number: number; title: string; url: string; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean;
    createdAt: string; mergedAt: string | null; closedAt: string | null; author: Actor; mergedBy: Actor;
    reviews: { nodes: Array<{ id: string; state: string; submittedAt: string | null; url: string; author: Actor }> };
  }> };
  issues: { nodes: Array<{
    number: number; title: string; url: string; createdAt: string; closedAt: string | null; author: Actor;
  }> };
} | null;

const REPO_FIELDS = `nameWithOwner name owner{login} url description isPrivate isArchived isFork pushedAt
  primaryLanguage{name} languages(first:3,orderBy:{field:SIZE,direction:DESC}){nodes{name}} repositoryTopics(first:15){nodes{topic{name}}}
  object(expression:"HEAD:"){... on Tree{entries{name type}}}`;
const ACTOR = `__typename login avatarUrl`;

export class WorkHub {
  private readonly file: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ghToken: () => Promise<string | null>;
  private readonly git: GitRunner;
  private readonly now: () => number;
  private connectionCache: Cached<WorkConnection> | null = null;
  private reposCache: Cached<WorkRepoList> | null = null;
  private overviewCache = new Map<WorkScope, Cached<WorkOverview>>();
  /** What needs the person does not depend on the scope, and is the slowest question to ask. */
  private attentionCache: Cached<AttentionItem[]> | null = null;
  private publishing = new Set<string>();

  constructor(options: WorkHubOptions) {
    this.file = join(options.home, "github.json");
    this.fetchImpl = options.fetch ?? fetch;
    this.ghToken = options.ghToken ?? ghCliToken;
    this.git = options.git ?? defaultGit;
    this.now = options.now ?? Date.now;
  }

  /* ---------- token ---------- */

  private async saved(): Promise<Saved> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Saved;
      return {
        ...(typeof parsed.token === "string" && parsed.token ? { token: parsed.token } : {}),
        ...(Array.isArray(parsed.watched) ? { watched: parsed.watched.filter((x): x is string => typeof x === "string") } : {}),
      };
    } catch {
      return {};
    }
  }

  private async save(next: Saved): Promise<void> {
    if (!next.token && !next.watched) { await rm(this.file, { force: true }); return; }
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.file, 0o600).catch(() => undefined);
  }

  private async credential(): Promise<Credential | null> {
    const { token } = await this.saved();
    if (token) return { token, source: "token" };
    const gh = await this.ghToken();
    return gh ? { token: gh, source: "gh" } : null;
  }

  private async need(): Promise<Credential> {
    const credential = await this.credential();
    if (!credential) throw new WorkHubError("github_not_connected", 401, "Connect GitHub to see your work.");
    return credential;
  }

  private clear(): void {
    this.connectionCache = null; this.reposCache = null; this.overviewCache.clear(); this.attentionCache = null;
  }

  private cached<T>(slot: Cached<T> | null | undefined, key: string, ttlMs: number, refresh: boolean, load: () => Promise<T>, store: (next: Cached<T> | null) => void): Promise<T> {
    if (slot && !refresh && slot.key === key && this.now() - slot.at < ttlMs) return slot.value;
    const entry: Cached<T> = { at: this.now(), key, value: load() };
    store(entry);
    // A failure is not worth keeping: the next call retries.
    entry.value.catch(() => store(null));
    return entry.value;
  }

  /* ---------- transport ---------- */

  private async call(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "fabPlane",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new WorkHubError("github_offline", 503, "Could not reach GitHub. Check the connection and try again.");
    }
    if (res.status === 401) throw new WorkHubError("github_token_invalid", 401, "GitHub rejected the saved token. Connect again.");
    if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")))
      throw new WorkHubError("github_rate_limited", 429, "GitHub's request limit was reached. Try again in a few minutes.");
    return res;
  }

  private async graphql<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<{ data: T; scopes: string | null }> {
    const res = await this.call(token, "/graphql", { method: "POST", body: { query, variables } });
    const body = await res.json().catch(() => null) as { data?: T; errors?: Array<{ type?: string; message: string }> } | null;
    if (!res.ok || !body?.data) {
      const first = body?.errors?.[0];
      if (first?.type === "RATE_LIMITED") throw new WorkHubError("github_rate_limited", 429, "GitHub's request limit was reached. Try again in a few minutes.");
      throw new WorkHubError("github_error", 502, first?.message ?? `GitHub answered ${res.status}.`);
    }
    // Partial data (one repository renamed, an organization that blocks the token) is still useful.
    return { data: body.data, scopes: res.headers.get("x-oauth-scopes") };
  }

  /* ---------- connection ---------- */

  connection(refresh = false): Promise<WorkConnection> {
    return this.cached(this.connectionCache, "connection", 60_000, refresh, () => this.loadConnection(), next => { this.connectionCache = next; });
  }

  private async loadConnection(): Promise<WorkConnection> {
    const credential = await this.credential();
    if (!credential) return { connected: false, reason: "missing", message: "Sign in with the GitHub CLI (`gh auth login`) or paste a personal access token." };
    type Data = { viewer: {
      login: string; name: string | null; avatarUrl: string;
      organizations: { nodes: Array<{ login: string; avatarUrl: string }> };
      contributionsCollection: { commitContributionsByRepository: Array<{ repository: { owner: { login: string } } }> };
    } };
    let result: { data: Data; scopes: string | null };
    try {
      result = await this.graphql<Data>(credential.token, `query{viewer{login name avatarUrl
        organizations(first:50){nodes{login avatarUrl}}
        contributionsCollection{commitContributionsByRepository(maxRepositories:50){repository{owner{login}}}}}}`);
    } catch (error) {
      if (error instanceof WorkHubError && error.code === "github_token_invalid") return { connected: false, reason: "invalid", message: error.message };
      if (error instanceof WorkHubError && error.code === "github_offline") return { connected: false, reason: "offline", message: error.message };
      throw error;
    }
    const { viewer } = result.data;
    const saved = (await this.saved()).watched;
    // Until the person chooses, watch their own account and the organizations they committed to
    // this year. Membership alone is not interest: one large organization can hide everything else.
    const contributed = new Set(viewer.contributionsCollection.commitContributionsByRepository.map(row => row.repository.owner.login.toLowerCase()));
    const watched = new Set((saved ?? [viewer.login, ...viewer.organizations.nodes.map(org => org.login).filter(login => contributed.has(login.toLowerCase()))]).map(login => login.toLowerCase()));
    const owners: WorkOwner[] = [
      { login: viewer.login, avatarUrl: viewer.avatarUrl, kind: "user", watched: watched.has(viewer.login.toLowerCase()) },
      ...viewer.organizations.nodes.map((org): WorkOwner => ({ login: org.login, avatarUrl: org.avatarUrl, kind: "organization", watched: watched.has(org.login.toLowerCase()) })),
    ];
    const scopes = result.scopes?.split(",").map(scope => scope.trim()).filter(Boolean);
    return {
      connected: true, source: credential.source,
      viewer: { login: viewer.login, name: viewer.name, avatarUrl: viewer.avatarUrl },
      owners,
      // Fine-grained tokens report no scopes; GitHub decides when the push happens.
      canPublish: !scopes?.length || scopes.includes("repo"),
    };
  }

  async update(input: UpdateWorkConnection): Promise<WorkConnection> {
    const saved = await this.saved();
    if (input.token) {
      // Prove the token before replacing a working one.
      const res = await this.call(input.token, "/user");
      if (!res.ok) throw new WorkHubError("github_error", 502, `GitHub answered ${res.status} for that token.`);
    }
    await this.save({
      ...(input.token ? { token: input.token } : saved.token ? { token: saved.token } : {}),
      ...(input.watched ? { watched: input.watched } : saved.watched ? { watched: saved.watched } : {}),
    });
    this.clear();
    return this.connection();
  }

  /** Forget the saved token. A GitHub CLI login, if any, still connects. */
  async disconnect(): Promise<WorkConnection> {
    const { watched } = await this.saved();
    await this.save(watched ? { watched } : {});
    this.clear();
    return this.connection();
  }

  private async watchedOwners(): Promise<string[]> {
    const connection = await this.connection();
    if (!connection.connected) {
      if (connection.reason === "missing") throw new WorkHubError("github_not_connected", 401, "Connect GitHub to see your work.");
      throw new WorkHubError(connection.reason === "invalid" ? "github_token_invalid" : "github_offline", connection.reason === "invalid" ? 401 : 503, connection.message);
    }
    return connection.owners.filter(owner => owner.watched).map(owner => owner.login);
  }

  /* ---------- repositories ---------- */

  repos(refresh = false): Promise<WorkRepoList> {
    return this.cached(this.reposCache, "repos", 5 * 60_000, refresh, () => this.loadRepos(), next => { this.reposCache = next; });
  }

  private async loadRepos(): Promise<WorkRepoList> {
    const { token } = await this.need();
    const owners = await this.watchedOwners();
    const truncated: string[] = [];
    const lists = await Promise.all(owners.map(async (login) => {
      const out: WorkRepo[] = [];
      let cursor: string | null = null;
      for (;;) {
        const result: { data: RepoPage } = await this.graphql<RepoPage>(token, `query($login:String!,$cursor:String){repositoryOwner(login:$login){
          repositories(first:50,after:$cursor,ownerAffiliations:[OWNER],orderBy:{field:PUSHED_AT,direction:DESC}){
            pageInfo{hasNextPage endCursor} nodes{${REPO_FIELDS}}}}}`, { login, cursor });
        const page: RepoConnection | undefined = result.data.repositoryOwner?.repositories;
        if (!page) break;
        for (const node of page.nodes) if (node) out.push(toRepo(node));
        if (!page.pageInfo.hasNextPage) break;
        if (out.length >= REPOS_PER_OWNER) { truncated.push(login); break; }
        cursor = page.pageInfo.endCursor;
      }
      return out;
    }));
    const repos = lists.flat().sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
    return { repos, truncated, fetchedAt: new Date(this.now()).toISOString() };
  }

  /* ---------- overview: attention, feed, team ---------- */

  overview(scope: WorkScope, refresh = false): Promise<WorkOverview> {
    return this.cached(this.overviewCache.get(scope), scope, 120_000, refresh, () => this.loadOverview(scope, refresh), next => {
      if (next) this.overviewCache.set(scope, next); else this.overviewCache.delete(scope);
    });
  }

  private async loadOverview(scope: WorkScope, refresh: boolean): Promise<WorkOverview> {
    const { token } = await this.need();
    const [owners, listing] = await Promise.all([this.watchedOwners(), this.repos(refresh)]);
    const inScope = listing.repos.filter(repo => !repo.archived && (scope === "all" || repo.hardware));
    const since = new Date(this.now() - SINCE_DAYS * 86_400_000).toISOString();
    const active = inScope.filter(repo => repo.pushedAt && repo.pushedAt >= since).slice(0, ACTIVE_REPOS);
    const scopeNames = new Set(inScope.map(repo => repo.fullName.toLowerCase()));
    const [attention, activity] = await Promise.all([
      owners.length ? this.cached(this.attentionCache, owners.join(","), 120_000, refresh, () => this.loadAttention(token, owners), next => { this.attentionCache = next; }) : Promise.resolve([]),
      active.length ? this.loadActivity(token, active, since) : Promise.resolve({ feed: [], team: [] }),
    ]);
    return {
      scope,
      repos: active.map(repo => repo.fullName),
      attention: scope === "all" ? attention : attention.filter(item => scopeNames.has(item.repo.toLowerCase())),
      feed: activity.feed.slice(0, FEED_LIMIT),
      team: activity.team,
      sinceDays: SINCE_DAYS,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  private async loadAttention(token: string, owners: string[]): Promise<AttentionItem[]> {
    const within = owners.map(owner => `user:${owner}`).join(" ");
    const node = `__typename ... on PullRequest{number title url updatedAt isDraft repository{nameWithOwner} author{${ACTOR}}
        reviewDecision mergeable commits(last:1){nodes{commit{statusCheckRollup{state}}}}}
      ... on Issue{number title url updatedAt repository{nameWithOwner} author{${ACTOR}}}`;
    type Search = { nodes: Array<SearchPr | null> };
    // Three requests rather than one: GitHub runs a query's fields one after another.
    const search = async (query: string, first: number): Promise<Search> =>
      (await this.graphql<{ search: Search }>(token, `query($query:String!,$first:Int!){search(query:$query,type:ISSUE,first:$first){nodes{${node}}}}`, { query, first })).data.search;
    const [review, mine, assigned] = await Promise.all([
      search(`is:open is:pr review-requested:@me archived:false sort:updated-desc ${within}`, 40),
      search(`is:open is:pr author:@me archived:false sort:updated-desc ${within}`, 60),
      search(`is:open assignee:@me archived:false sort:updated-desc ${within}`, 40),
    ]);
    const data = { review, mine, assigned };
    const items = new Map<string, AttentionItem>();
    const add = (row: SearchPr | null, reasons: AttentionReason[]) => {
      if (!row?.url || !reasons.length) return;
      const existing = items.get(row.url);
      if (existing) { for (const reason of reasons) if (!existing.reasons.includes(reason)) existing.reasons.push(reason); return; }
      items.set(row.url, {
        id: row.url, kind: row.__typename === "PullRequest" ? "pull_request" : "issue",
        repo: row.repository.nameWithOwner, number: row.number, title: row.title, url: row.url,
        author: actor(row.author), draft: !!row.isDraft, updatedAt: row.updatedAt, reasons: [...reasons],
      });
    };
    for (const row of data.review.nodes) add(row, ["review_requested"]);
    for (const row of data.mine.nodes) {
      if (!row) continue;
      const checks = row.commits?.nodes[0]?.commit.statusCheckRollup?.state;
      const failing = checks === "FAILURE" || checks === "ERROR";
      const conflict = row.mergeable === "CONFLICTING";
      const reasons: AttentionReason[] = [];
      if (row.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes_requested");
      if (failing) reasons.push("checks_failing");
      if (conflict) reasons.push("merge_conflict");
      if (row.reviewDecision === "APPROVED" && !failing && !conflict && !row.isDraft && checks !== "PENDING") reasons.push("ready_to_merge");
      add(row, reasons);
    }
    for (const row of data.assigned.nodes) add(row, ["assigned"]);
    const rank = (item: AttentionItem) => Math.min(...item.reasons.map(reason => REASON_ORDER.indexOf(reason)));
    for (const item of items.values()) item.reasons.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
    return [...items.values()].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  }

  private async loadActivity(token: string, repos: WorkRepo[], since: string): Promise<{ feed: WorkEvent[]; team: TeamMember[] }> {
    const fields = `nameWithOwner
      defaultBranchRef{target{... on Commit{history(first:15,since:$since){nodes{oid messageHeadline committedDate url author{name user{${ACTOR}}}}}}}}
      pullRequests(first:15,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url state isDraft createdAt mergedAt closedAt
        author{${ACTOR}} mergedBy{${ACTOR}} reviews(last:5){nodes{id state submittedAt url author{${ACTOR}}}}}}
      issues(first:15,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url createdAt closedAt author{${ACTOR}}}}`;
    // A few repositories per request, in parallel: one large query is answered several times slower.
    const batches: WorkRepo[][] = [];
    for (let index = 0; index < repos.length; index += ACTIVITY_BATCH) batches.push(repos.slice(index, index + ACTIVITY_BATCH));
    const answers = await Promise.all(batches.map(batch => this.graphql<Record<string, ActivityRepo>>(token, `query($since:GitTimestamp!){${batch.map((repo, index) =>
      `r${index}:repository(owner:${JSON.stringify(repo.owner)},name:${JSON.stringify(repo.name)}){${fields}}`).join("\n")}}`, { since })));
    const feed: WorkEvent[] = [];
    const open = new Map<string, TeamMember["openPullRequests"]>();
    for (const repo of answers.flatMap(answer => Object.values(answer.data))) {
      if (!repo) continue;
      const name = repo.nameWithOwner;
      for (const commit of repo.defaultBranchRef?.target?.history?.nodes ?? []) {
        // A merge commit repeats what the pull request's own event already says.
        if (/^Merge (pull request|branch|remote-tracking branch) /.test(commit.messageHeadline)) continue;
        const who = actor(commit.author?.user);
        feed.push({ id: `commit:${name}:${commit.oid}`, kind: "commit", repo: name, actor: who,
          ...(!who && commit.author?.name ? { actorName: commit.author.name } : {}),
          title: commit.messageHeadline, url: commit.url, at: commit.committedDate });
      }
      for (const pr of repo.pullRequests.nodes) {
        const base = { repo: name, title: pr.title, number: pr.number, url: pr.url };
        const author = actor(pr.author);
        if (pr.state === "OPEN" && author) {
          const list = open.get(author.login) ?? [];
          list.push({ repo: name, number: pr.number, title: pr.title, url: pr.url, draft: pr.isDraft });
          open.set(author.login, list);
        }
        if (pr.createdAt >= since) feed.push({ ...base, id: `pr:${name}#${pr.number}:opened`, kind: "pr_opened", actor: author, at: pr.createdAt });
        if (pr.mergedAt && pr.mergedAt >= since) feed.push({ ...base, id: `pr:${name}#${pr.number}:merged`, kind: "pr_merged", actor: actor(pr.mergedBy) ?? author, at: pr.mergedAt });
        else if (pr.state === "CLOSED" && pr.closedAt && pr.closedAt >= since) feed.push({ ...base, id: `pr:${name}#${pr.number}:closed`, kind: "pr_closed", actor: author, at: pr.closedAt });
        for (const review of pr.reviews.nodes) {
          const state = review.state === "APPROVED" ? "approved" : review.state === "CHANGES_REQUESTED" ? "changes_requested" : review.state === "COMMENTED" ? "commented" : null;
          const reviewer = actor(review.author);
          if (!state || !review.submittedAt || review.submittedAt < since) continue;
          // Replying on your own pull request is conversation, not a review.
          if (state === "commented" && reviewer?.login === author?.login) continue;
          feed.push({ ...base, id: `review:${review.id}`, kind: "review", review: state, actor: reviewer, url: review.url, at: review.submittedAt });
        }
      }
      for (const issue of repo.issues.nodes) {
        const base = { repo: name, title: issue.title, number: issue.number, url: issue.url, actor: actor(issue.author) };
        if (issue.createdAt >= since) feed.push({ ...base, id: `issue:${name}#${issue.number}:opened`, kind: "issue_opened", at: issue.createdAt });
        if (issue.closedAt && issue.closedAt >= since) feed.push({ ...base, id: `issue:${name}#${issue.number}:closed`, kind: "issue_closed", at: issue.closedAt });
      }
    }
    feed.sort((a, b) => b.at.localeCompare(a.at));
    const members = new Map<string, TeamMember>();
    for (const event of feed) {
      const who = event.actor;
      if (!who || who.bot) continue;
      let member = members.get(who.login);
      if (!member) {
        member = { ...who, lastActiveAt: event.at, commits: 0, pullRequests: 0, reviews: 0, issues: 0, openPullRequests: open.get(who.login) ?? [], latest: event };
        members.set(who.login, member);
      }
      if (event.kind === "commit") member.commits++;
      else if (event.kind === "pr_opened" || event.kind === "pr_merged") member.pullRequests++;
      else if (event.kind === "review") member.reviews++;
      else if (event.kind === "issue_opened" || event.kind === "issue_closed") member.issues++;
    }
    return { feed, team: [...members.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)) };
  }

  /* ---------- a project's repository ---------- */

  async projectLink(dir: string): Promise<ProjectGitHubLink> {
    const top = await this.git(["rev-parse", "--show-toplevel"], { cwd: dir }).catch(() => null);
    // A project folder inside someone else's checkout has no repository of its own.
    if (!top || top.exitCode !== 0 || !(await sameDirectory(top.stdout.trim(), dir))) return { repo: null, otherRemote: false };
    const remote = await this.git(["remote", "get-url", "origin"], { cwd: dir });
    if (remote.exitCode !== 0 || !remote.stdout.trim()) return { repo: null, otherRemote: false };
    const repo = gitHubRepoFromRemote(remote.stdout);
    return { repo, otherRemote: !repo };
  }

  /**
   * Put a project on GitHub: commit what is in the folder, create the repository, add it as
   * `origin` and push. The token reaches git through its environment, never its arguments or the
   * saved remote URL.
   */
  async publish(dir: string, input: { owner: string; name: string; private: boolean; description?: string | undefined }): Promise<ProjectGitHubLink> {
    if (this.publishing.has(dir)) throw new WorkHubError("already_published", 409, "This project is already being published.");
    this.publishing.add(dir);
    try {
      const { token } = await this.need();
      const link = await this.projectLink(dir);
      if (link.repo) throw new WorkHubError("already_published", 409, `This project is already on GitHub as ${link.repo.fullName}.`);
      if (link.otherRemote) throw new WorkHubError("other_remote", 409, "This project already has a git remote named origin that is not GitHub.");
      const connection = await this.connection();
      if (!connection.connected) throw new WorkHubError("github_not_connected", 401, connection.message);
      const own = connection.viewer.login.toLowerCase() === input.owner.toLowerCase();
      if (!own && !connection.owners.some(owner => owner.login.toLowerCase() === input.owner.toLowerCase()))
        throw new WorkHubError("cannot_publish", 403, `You are not a member of ${input.owner} on GitHub.`);
      await commitMilestone(dir, "Publish to GitHub", this.git);
      const head = await this.git(["rev-parse", "--verify", "HEAD"], { cwd: dir });
      if (head.exitCode !== 0) throw new WorkHubError("push_failed", 412, "This project has no files to publish yet.");

      const res = await this.call(token, own ? "/user/repos" : `/orgs/${encodeURIComponent(input.owner)}/repos`, {
        method: "POST",
        body: { name: input.name, private: input.private, ...(input.description ? { description: input.description } : {}) },
      });
      const body = await res.json().catch(() => null) as { full_name?: string; html_url?: string; clone_url?: string; message?: string; errors?: Array<{ message?: string }> } | null;
      if (res.status === 422) throw new WorkHubError("repo_exists", 409, body?.errors?.[0]?.message ?? `${input.owner}/${input.name} already exists on GitHub. Choose another name.`);
      if (res.status === 403 || res.status === 404) throw new WorkHubError("cannot_publish", 403, `GitHub did not allow creating a repository in ${input.owner}. The token needs the repo scope and permission in that account.`);
      if (!res.ok || !body?.full_name || !body.clone_url) throw new WorkHubError("github_error", 502, body?.message ?? `GitHub answered ${res.status}.`);

      const repo = { fullName: body.full_name, url: body.html_url ?? `https://github.com/${body.full_name}` };
      const add = await this.git(["remote", "add", "origin", body.clone_url], { cwd: dir });
      if (add.exitCode !== 0) throw new WorkHubError("push_failed", 500, `Created ${repo.fullName}, but could not add it as a remote: ${add.stderr.trim()}`);
      const push = await this.git(["push", "--set-upstream", "origin", "HEAD"], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        },
      });
      if (push.exitCode !== 0)
        throw new WorkHubError("push_failed", 502, `Created ${repo.fullName}, but the first push failed: ${push.stderr.trim().split("\n").pop() ?? "git push failed"}`);
      this.reposCache = null; this.overviewCache.clear();
      return { repo, otherRemote: false };
    } finally {
      this.publishing.delete(dir);
    }
  }
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  const { realpath } = await import("node:fs/promises");
  const [left, right] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return left === right;
}

function toRepo(node: RepoNode): WorkRepo {
  const signals = hardwareSignals({
    languages: node.languages?.nodes.map(language => language.name) ?? [],
    topics: node.repositoryTopics?.nodes.map(row => row.topic.name) ?? [],
    rootEntries: (node.object?.entries ?? []).map(entry => ({ name: entry.name, directory: entry.type === "tree" })),
  });
  return {
    fullName: node.nameWithOwner, owner: node.owner.login, name: node.name, url: node.url,
    description: node.description, private: node.isPrivate, archived: node.isArchived, fork: node.isFork,
    pushedAt: node.pushedAt, language: node.primaryLanguage?.name ?? null,
    hardware: signals.length > 0, hardwareSignals: signals,
  };
}
