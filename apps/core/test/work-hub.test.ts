import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod/v4";
import { defaultGit } from "../src/finish-it-git";
import { workRoutes } from "../src/http/work-routes";
import { WorkHub, WorkHubError } from "../src/work-hub";

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function temp(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `work-hub-${name}-`));
  roots.push(root);
  return root;
}

const NOW = Date.parse("2026-11-27T12:00:00Z");
const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuv";
const avatar = (login: string) => `https://avatars.example/${login}`;
const user = (login: string, type = "User") => ({ __typename: type, login, avatarUrl: avatar(login) });

function repoNode(owner: string, name: string, pushedAt: string, entries: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    nameWithOwner: `${owner}/${name}`, name, owner: { login: owner }, url: `https://github.com/${owner}/${name}`, description: null,
    isPrivate: true, isArchived: false, isFork: false, pushedAt, primaryLanguage: { name: "TypeScript" },
    languages: { nodes: [{ name: "TypeScript" }] }, repositoryTopics: { nodes: [] },
    object: { entries: entries.map(entry => entry.endsWith("/") ? { name: entry.slice(0, -1), type: "tree" } : { name: entry, type: "blob" }) },
    ...extra,
  };
}

/** A GitHub that answers the hub's four GraphQL queries and records what it was asked. */
function fakeGitHub(options: { status?: number; scopes?: string; create?: (path: string, body: Record<string, unknown>) => Response } = {}) {
  const calls: Array<{ path: string; auth: string | null; query?: string; variables?: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) as { query?: string; variables?: Record<string, unknown> } : {};
    calls.push({ path, auth: headers.get("authorization"), ...(body.query ? { query: body.query, variables: body.variables ?? {} } : {}) });
    if (options.status) return new Response("{}", { status: options.status });
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "x-oauth-scopes": options.scopes ?? "repo, read:org" } });
    if (path === "/user") return new Response("{}");
    if (path !== "/graphql") return options.create?.(path, body as Record<string, unknown>) ?? new Response("{}", { status: 404 });
    const query = body.query ?? "";
    if (query.includes("contributionsCollection")) return json({ viewer: {
      ...user("matt"), name: "Matt",
      organizations: { nodes: [{ login: "fabPlane", avatarUrl: avatar("fabPlane") }, { login: "EpicGames", avatarUrl: avatar("EpicGames") }] },
      contributionsCollection: { commitContributionsByRepository: [{ repository: { owner: { login: "fabplane" } } }] },
    } });
    if (query.includes("repositoryOwner")) {
      const login = body.variables?.["login"];
      const nodes = login === "fabPlane" ? [
        repoNode("fabPlane", "fabdesk", "2026-11-27T08:00:00Z"),
        repoNode("fabPlane", "viagrid", "2026-11-26T08:00:00Z", ["viagrid.kicad_pcb", "README.md"]),
        repoNode("fabPlane", "old-board", "2026-01-01T00:00:00Z", ["hardware/"]),
        repoNode("fabPlane", "archived-board", "2026-11-25T00:00:00Z", ["pcb/"], { isArchived: true }),
        null,
      ] : login === "matt" ? [repoNode("matt", "dotfiles", "2026-11-20T00:00:00Z")] : [];
      return json({ repositoryOwner: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
    }
    if (query.includes("search(query:$query")) {
      const which = String(body.variables?.["query"]).includes("review-requested") ? "review" : String(body.variables?.["query"]).includes("author:@me") ? "mine" : "assigned";
      const pr = (repo: string, number: number, extra: Record<string, unknown>) => ({ __typename: "PullRequest", number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, updatedAt: "2026-11-27T09:00:00Z", isDraft: false, repository: { nameWithOwner: repo }, author: user("matt"), reviewDecision: null, mergeable: "MERGEABLE", commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, ...extra });
      return json({ search: ({
        review: { nodes: [pr("fabPlane/viagrid", 7, { author: user("ana"), updatedAt: "2026-11-26T09:00:00Z" })] },
        mine: { nodes: [
          pr("fabPlane/fabdesk", 96, { reviewDecision: "APPROVED" }),
          pr("fabPlane/fabdesk", 97, { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] }, mergeable: "CONFLICTING" }),
          pr("fabPlane/fabdesk", 98, {}),
          pr("fabPlane/fabdesk", 99, { reviewDecision: "APPROVED", isDraft: true }),
          null,
        ] },
        assigned: { nodes: [
          { __typename: "Issue", number: 12, title: "Fix silkscreen", url: "https://github.com/fabPlane/viagrid/issues/12", updatedAt: "2026-11-20T09:00:00Z", repository: { nameWithOwner: "fabPlane/viagrid" }, author: user("ana") },
          pr("fabPlane/viagrid", 7, { author: user("ana") }),
        ] },
      })[which] });
    }
    if (query.includes("r0:repository")) {
      const data: Record<string, unknown> = {};
      for (const match of query.matchAll(/(r\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)/g)) {
        const full = `${match[2]}/${match[3]}`;
        data[match[1]!] = full !== "fabPlane/viagrid" ? full === "matt/dotfiles" ? null : { nameWithOwner: full, defaultBranchRef: null, pullRequests: { nodes: [] }, issues: { nodes: [] } } : {
          nameWithOwner: full,
          defaultBranchRef: { target: { history: { nodes: [
            { oid: "a1", messageHeadline: "Route the power stage", committedDate: "2026-11-27T10:00:00Z", url: `https://github.com/${full}/commit/a1`, author: { name: "Ana", user: user("ana") } },
            { oid: "a2", messageHeadline: "Merge pull request #6 from x/y", committedDate: "2026-11-27T09:30:00Z", url: `https://github.com/${full}/commit/a2`, author: { name: "Ana", user: user("ana") } },
            { oid: "a3", messageHeadline: "Tune stencil", committedDate: "2026-11-26T10:00:00Z", url: `https://github.com/${full}/commit/a3`, author: { name: "Unlinked Person", user: null } },
            { oid: "a4", messageHeadline: "Bump deps", committedDate: "2026-11-26T09:00:00Z", url: `https://github.com/${full}/commit/a4`, author: { name: "dependabot", user: user("dependabot[bot]", "Bot") } },
          ] } } },
          pullRequests: { nodes: [
            { number: 6, title: "Add test points", url: `https://github.com/${full}/pull/6`, state: "MERGED", isDraft: false, createdAt: "2026-11-01T00:00:00Z", mergedAt: "2026-11-27T09:30:00Z", closedAt: "2026-11-27T09:30:00Z", author: user("ana"), mergedBy: user("matt"),
              reviews: { nodes: [
                { id: "R1", state: "APPROVED", submittedAt: "2026-11-27T09:00:00Z", url: `https://github.com/${full}/pull/6#r1`, author: user("matt") },
                { id: "R2", state: "COMMENTED", submittedAt: "2026-11-27T08:00:00Z", url: `https://github.com/${full}/pull/6#r2`, author: user("ana") },
                { id: "R3", state: "PENDING", submittedAt: null, url: "", author: user("matt") },
              ] } },
            { number: 7, title: "Bigger pads", url: `https://github.com/${full}/pull/7`, state: "OPEN", isDraft: true, createdAt: "2026-11-25T00:00:00Z", mergedAt: null, closedAt: null, author: user("ana"), mergedBy: null, reviews: { nodes: [] } },
            { number: 5, title: "Abandoned", url: `https://github.com/${full}/pull/5`, state: "CLOSED", isDraft: false, createdAt: "2026-10-01T00:00:00Z", mergedAt: null, closedAt: "2026-11-24T00:00:00Z", author: user("bo"), mergedBy: null, reviews: { nodes: [] } },
          ] },
          issues: { nodes: [
            { number: 12, title: "Fix silkscreen", url: `https://github.com/${full}/issues/12`, createdAt: "2026-11-23T00:00:00Z", closedAt: null, author: user("matt") },
            { number: 3, title: "Ancient", url: `https://github.com/${full}/issues/3`, createdAt: "2025-01-01T00:00:00Z", closedAt: "2025-02-01T00:00:00Z", author: user("matt") },
          ] },
        };
      }
      return json(data);
    }
    return new Response(JSON.stringify({ errors: [{ message: "unexpected query" }] }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function hub(name: string, options: Parameters<typeof fakeGitHub>[0] & { gh?: string | null } = {}) {
  const home = await temp(name);
  const github = fakeGitHub(options);
  const work = new WorkHub({ home, fetch: github.fetchImpl, ghToken: async () => options.gh === undefined ? TOKEN : options.gh, now: () => NOW });
  return { home, work, ...github };
}

test("connection: borrows the GitHub CLI login, watches the accounts the person commits to, and reports a missing or rejected token", async () => {
  const { work, calls } = await hub("connection");
  const connection = await work.connection();
  if (!connection.connected) throw new Error("expected a connection");
  expect(connection.source).toBe("gh");
  expect(connection.viewer.login).toBe("matt");
  expect(connection.canPublish).toBe(true);
  // A member of a huge organization they never commit to is not flooded by it.
  expect(connection.owners.map(owner => [owner.login, owner.kind, owner.watched])).toEqual([["matt", "user", true], ["fabPlane", "organization", true], ["EpicGames", "organization", false]]);
  expect(calls.every(call => call.auth === `Bearer ${TOKEN}`)).toBe(true);
  await work.connection();
  expect(calls).toHaveLength(1);

  expect(await (await hub("missing", { gh: null })).work.connection()).toMatchObject({ connected: false, reason: "missing" });
  expect(await (await hub("invalid", { status: 401 })).work.connection()).toMatchObject({ connected: false, reason: "invalid" });
  const readOnly = await (await hub("scopes", { scopes: "read:org" })).work.connection();
  expect(readOnly.connected && readOnly.canPublish).toBe(false);
});

test("a saved token is validated first, kept private on disk, preferred over the CLI, and forgotten on disconnect", async () => {
  const { work, home, calls } = await hub("token", { gh: null });
  const saved = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
  const connection = await work.update({ token: saved, watched: ["fabPlane"] });
  expect(connection.connected && connection.source).toBe("token");
  expect(connection.connected && connection.owners.filter(owner => owner.watched).map(owner => owner.login)).toEqual(["fabPlane"]);
  expect(calls[0]).toMatchObject({ path: "/user", auth: `Bearer ${saved}` });
  const file = join(home, "github.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ token: saved, watched: ["fabPlane"] });
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await work.disconnect()).toMatchObject({ connected: false, reason: "missing" });
  // The choice of accounts outlives the token.
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ watched: ["fabPlane"] });

  const rejected = await hub("rejected", { status: 401, gh: null });
  await expect(rejected.work.update({ token: saved })).rejects.toMatchObject({ code: "github_token_invalid" });
  await expect(stat(join(rejected.home, "github.json"))).rejects.toThrow();
});

test("repositories: scans only watched accounts and flags hardware from the files at the top of the repository", async () => {
  const { work, calls } = await hub("repos");
  const list = await work.repos();
  expect(calls.filter(call => call.query?.includes("repositoryOwner")).map(call => call.variables?.["login"]).sort()).toEqual(["fabPlane", "matt"]);
  expect(list.repos.map(repo => repo.fullName)).toEqual(["fabPlane/fabdesk", "fabPlane/viagrid", "fabPlane/archived-board", "matt/dotfiles", "fabPlane/old-board"]);
  expect(list.repos.filter(repo => repo.hardware).map(repo => [repo.name, repo.hardwareSignals])).toEqual([["viagrid", ["viagrid.kicad_pcb"]], ["archived-board", ["pcb/"]], ["old-board", ["hardware/"]]]);
  expect(list.truncated).toEqual([]);
});

test("overview: ranks what needs the person, builds the feed and the team from recent activity, and narrows to hardware", async () => {
  const { work, calls } = await hub("overview");
  const all = await work.overview("all");
  // Recently pushed, unarchived repositories only; a repository GitHub no longer returns is skipped.
  expect(all.repos).toEqual(["fabPlane/fabdesk", "fabPlane/viagrid", "matt/dotfiles"]);
  expect(all.attention.map(item => [item.number, item.reasons])).toEqual([
    [7, ["review_requested", "assigned"]],
    [97, ["checks_failing", "merge_conflict"]],
    [96, ["ready_to_merge"]],
    [12, ["assigned"]],
  ]);
  const searches = calls.filter(call => call.query?.includes("search(query:$query")).map(call => call.variables?.["query"]);
  expect(searches).toHaveLength(3);
  expect(searches).toContain("is:open is:pr review-requested:@me archived:false sort:updated-desc user:matt user:fabPlane");
  expect(all.feed.map(event => [event.kind, event.actor?.login ?? event.actorName, event.number ?? event.title])).toEqual([
    ["commit", "ana", "Route the power stage"],
    ["pr_merged", "matt", 6],
    ["review", "matt", 6],
    ["commit", "Unlinked Person", "Tune stencil"],
    ["commit", "dependabot[bot]", "Bump deps"],
    ["pr_opened", "ana", 7],
    ["pr_closed", "bo", 5],
    ["issue_opened", "matt", 12],
  ]);
  expect(all.feed.find(event => event.kind === "review")?.review).toBe("approved");
  // Bots and commits without a GitHub account are in the feed but are not team members.
  expect(all.team.map(member => [member.login, member.commits, member.pullRequests, member.reviews, member.issues, member.openPullRequests.map(pr => pr.number)])).toEqual([
    ["ana", 1, 1, 0, 0, [7]],
    ["matt", 0, 1, 1, 1, []],
    ["bo", 0, 0, 0, 0, []],
  ]);
  expect(all.team[0]!.latest.title).toBe("Route the power stage");

  const before = calls.length;
  await work.overview("all");
  expect(calls.length).toBe(before);

  const hardware = await work.overview("hardware");
  expect(hardware.repos).toEqual(["fabPlane/viagrid"]);
  expect(hardware.attention.map(item => item.number)).toEqual([7, 12]);
  expect(hardware.feed).toHaveLength(8);
});

test("without a token the hub says so instead of asking GitHub", async () => {
  const { work, calls } = await hub("signed-out", { gh: null });
  await expect(work.overview("all")).rejects.toMatchObject({ code: "github_not_connected", status: 401 });
  await expect(work.repos()).rejects.toBeInstanceOf(WorkHubError);
  expect(calls).toEqual([]);
});

test("publish: commits the project, creates the repository, pushes with the token out of sight, and refuses to publish twice", async () => {
  const root = await temp("publish");
  const dir = join(root, "blinky"), bare = join(root, "remote.git");
  await mkdir(dir);
  await writeFile(join(dir, "fabdesk.json"), "{}");
  expect((await defaultGit(["init", "--bare", bare], { cwd: root })).exitCode).toBe(0);
  const created: Array<{ path: string; body: Record<string, unknown> }> = [];
  const git: string[][] = [];
  const github = fakeGitHub({ create: (path, body) => {
    created.push({ path, body });
    return new Response(JSON.stringify({ full_name: "fabPlane/blinky", html_url: "https://github.com/fabPlane/blinky", clone_url: bare }), { status: 201 });
  } });
  const work = new WorkHub({ home: join(root, "home"), fetch: github.fetchImpl, ghToken: async () => TOKEN, now: () => NOW,
    git: (args, opts) => { git.push(args); return defaultGit(args, opts); } });

  expect(await work.projectLink(dir)).toEqual({ repo: null, otherRemote: false });
  await expect(work.publish(dir, { owner: "someone-else", name: "blinky", private: true })).rejects.toMatchObject({ code: "cannot_publish" });
  expect(created).toEqual([]);

  expect(await work.publish(dir, { owner: "fabPlane", name: "blinky", private: true, description: "A blinker" })).toEqual({ repo: { fullName: "fabPlane/blinky", url: "https://github.com/fabPlane/blinky" }, otherRemote: false });
  expect(created).toEqual([{ path: "/orgs/fabPlane/repos", body: { name: "blinky", private: true, description: "A blinker" } }]);
  const pushed = await defaultGit(["log", "--format=%s", "--all"], { cwd: bare });
  expect(pushed.stdout.trim()).toBe("Publish to GitHub");
  expect((await defaultGit(["ls-tree", "--name-only", "-r", "HEAD"], { cwd: dir })).stdout).toContain("fabdesk.json");
  // The token never reaches git's arguments or the repository's saved configuration.
  expect(git.flat().join(" ")).not.toContain(TOKEN);
  expect(await readFile(join(dir, ".git", "config"), "utf8")).not.toMatch(/ghp_|x-access-token|extraheader/i);

  // The test remote is a folder, so the project now has a non-GitHub origin: publishing again must not touch it.
  expect(await work.projectLink(dir)).toEqual({ repo: null, otherRemote: true });
  await expect(work.publish(dir, { owner: "fabPlane", name: "again", private: true })).rejects.toMatchObject({ code: "other_remote" });
  expect(created).toHaveLength(1);
  expect((await defaultGit(["remote", "set-url", "origin", "git@github.com:fabPlane/blinky.git"], { cwd: dir })).exitCode).toBe(0);
  expect((await work.projectLink(dir)).repo?.fullName).toBe("fabPlane/blinky");
  await expect(work.publish(dir, { owner: "fabPlane", name: "again", private: true })).rejects.toMatchObject({ code: "already_published" });

  const taken = join(root, "taken");
  await mkdir(taken); await writeFile(join(taken, "fabdesk.json"), "{}");
  const conflict = new WorkHub({ home: join(root, "home2"), ghToken: async () => TOKEN, now: () => NOW,
    fetch: fakeGitHub({ create: () => new Response(JSON.stringify({ errors: [{ message: "name already exists on this account" }] }), { status: 422 }) }).fetchImpl });
  await expect(conflict.publish(taken, { owner: "matt", name: "taken", private: true })).rejects.toMatchObject({ code: "repo_exists", message: "name already exists on this account" });
  expect((await defaultGit(["remote"], { cwd: taken })).stdout.trim()).toBe("");
});

test("HTTP: reads work for any client, keeps token changes and publishing on the local desktop connection, and maps hub errors", async () => {
  const { work } = await hub("http");
  const build = (listener: "local" | "remote", workHub = work) => {
    const app = new Hono();
    app.onError((error, c) => error instanceof z.ZodError ? c.json({ code: "invalid_args" }, 400) : c.json({ error: error.message }, 500));
    workRoutes(app, { listener, workHub, projects: { handle: async () => null } as never });
    return app;
  };
  const local = build("local"), remote = build("remote");
  const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(await (await remote.request("/work/connection")).json()).toMatchObject({ connected: true, viewer: { login: "matt" } });
  expect(JSON.stringify(await (await remote.request("/work/connection")).json())).not.toContain(TOKEN);
  expect((await (await local.request("/work/overview?scope=hardware")).json() as { repos: string[] }).repos).toEqual(["fabPlane/viagrid"]);
  expect((await local.request("/work/overview?scope=everything")).status).toBe(400);
  expect((await (await local.request("/work/repos")).json() as { repos: unknown[] }).repos).toHaveLength(5);
  expect((await remote.request("/work/connection", json("PUT", { watched: [] }))).status).toBe(403);
  expect((await remote.request("/work/connection", { method: "DELETE" })).status).toBe(403);
  expect((await remote.request("/projects/p1/github", json("POST", { owner: "matt", name: "x" }))).status).toBe(403);
  expect((await local.request("/work/connection", json("PUT", { token: "nope" }))).status).toBe(400);
  expect((await local.request("/projects/missing/github")).status).toBe(404);
  expect((await local.request("/projects/missing/github", json("POST", { owner: "matt", name: "x" }))).status).toBe(404);
  const watched = await (await local.request("/work/connection", json("PUT", { watched: ["matt"] }))).json() as { owners: Array<{ login: string; watched: boolean }> };
  expect(watched.owners.filter(owner => owner.watched).map(owner => owner.login)).toEqual(["matt"]);

  const signedOut = build("local", (await hub("http-out", { gh: null })).work);
  const response = await signedOut.request("/work/overview");
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "github_not_connected" });
});
