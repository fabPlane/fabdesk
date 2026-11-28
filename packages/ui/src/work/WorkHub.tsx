import { useCore, useProjectGitHub, useProjects, useWorkConnection, useWorkMutations, useWorkOverview, useWorkRepos } from "@fabdesk/client-core";
import { suggestRepoName, type AttentionItem, type AttentionReason, type ProjectSummary, type TeamMember, type WorkActor, type WorkConnection, type WorkEvent, type WorkRepo, type WorkScope } from "@fabdesk/protocol";
import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { Badge, Button, Dialog, EmptyState, Input, Select, Spinner } from "../components/ui";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { formatRelative } from "../util";
import "./work-hub.css";

type Connected = Extract<WorkConnection, { connected: true }>;

const REASONS: Record<AttentionReason, { label: string; tone: "accent" | "warning" | "danger" | "success" | "neutral" }> = {
  review_requested: { label: "Review requested", tone: "accent" },
  changes_requested: { label: "Changes requested", tone: "warning" },
  checks_failing: { label: "Checks failing", tone: "danger" },
  merge_conflict: { label: "Merge conflict", tone: "danger" },
  ready_to_merge: { label: "Ready to merge", tone: "success" },
  assigned: { label: "Assigned to you", tone: "neutral" },
};

const SCOPE_KEY = "fabdesk.work.scope";

/** "5m ago", "3d ago", or "on Nov 12" once it is more than a week old. */
function ago(iso: string): string {
  const text = formatRelative(iso);
  if (text === "now") return "just now";
  return /^\d+[mhd]$/.test(text) ? `${text} ago` : `on ${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" })}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function Avatar({ actor, size = 22 }: { actor: WorkActor | null; size?: number }) {
  return actor?.avatarUrl
    ? <img className="fd-work-avatar" src={actor.avatarUrl} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" />
    : <span className="fd-work-avatar" style={{ width: size, height: size }} aria-hidden="true"><Icon name="user" width={size - 8} height={size - 8} /></span>;
}

/** A row that opens its GitHub page in the browser. */
function ExternalRow({ url, className, children, label }: { url: string; className?: string; children: React.ReactNode; label?: string }) {
  const { host } = useCore();
  return <button type="button" className={className} aria-label={label} onClick={() => void host.openExternal(url)}>{children}</button>;
}

function eventText(event: WorkEvent): string {
  const subject = event.number ? `#${event.number}` : "";
  switch (event.kind) {
    case "commit": return "pushed";
    case "pr_opened": return `opened ${subject}`;
    case "pr_merged": return `merged ${subject}`;
    case "pr_closed": return `closed ${subject}`;
    case "issue_opened": return `opened issue ${subject}`;
    case "issue_closed": return `closed issue ${subject}`;
    case "review": return event.review === "approved" ? `approved ${subject}` : event.review === "changes_requested" ? `requested changes on ${subject}` : `reviewed ${subject}`;
  }
}

function dayLabel(iso: string): string {
  const date = new Date(iso), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= start) return "Today";
  if (date.getTime() >= start - 86_400_000) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** How to get the GitHub CLI on the machine the core runs on. */
function installCommand(platform: string): string | null {
  return platform === "darwin" ? "brew install gh" : platform === "win32" ? "winget install --id GitHub.cli" : null;
}

function ConnectCard({ connection }: { connection: Extract<WorkConnection, { connected: false }> }) {
  const { update, recheck } = useWorkMutations();
  const { host } = useCore();
  const [step, setStep] = useState<"idle" | "allow" | "setup">("idle");
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState("");
  const install = installCommand(host.platform);
  const error = update.isError ? errorText(update.error) : connection.reason !== "missing" ? connection.message : null;
  // After "Check again" finds a signed-in CLI, go straight to asking for permission.
  const check = () => recheck.mutate(undefined, { onSuccess: (next) => { if (!next.connected && next.cli === "ready") setStep("allow"); } });
  return <section className="fd-work-connect" aria-label="Connect GitHub">
    <div className="fd-work-connect-lead">
      <div><h2>Connect GitHub</h2><p>See what needs you and what your team is doing.</p></div>
      {step === "idle" && <Button variant="primary" onClick={() => setStep(connection.cli === "ready" ? "allow" : "setup")}>Connect GitHub</Button>}
    </div>
    {step === "allow" && <div className="fd-work-connect-step" role="group" aria-label="Use the GitHub CLI login">
      <p>You’re signed in to the GitHub CLI on this computer. Let fabPlane use that login?</p>
      <div className="fd-work-publish-actions"><Button variant="primary" disabled={update.isPending} onClick={() => update.mutate({ useCli: true })}>{update.isPending ? "Connecting…" : "Allow"}</Button><Button disabled={update.isPending} onClick={() => setStep("idle")}>Not now</Button></div>
    </div>}
    {step === "setup" && <div className="fd-work-connect-step">
      <ol>
        {connection.cli === "not_installed" && <li>Install the GitHub CLI: {install ? <code>{install}</code> : <button type="button" className="fd-work-link" onClick={() => void host.openExternal("https://cli.github.com")}>cli.github.com</button>}</li>}
        <li>Sign in from a terminal: <code>gh auth login</code></li>
      </ol>
      <div className="fd-work-publish-actions"><Button variant="primary" disabled={recheck.isPending} onClick={check}>{recheck.isPending ? "Checking…" : "Check again"}</Button><Button onClick={() => setStep("idle")}>Cancel</Button></div>
      {recheck.isSuccess && !recheck.isPending && !recheck.data.connected && recheck.data.cli !== "ready" && <p role="status" className="fd-work-hint">{recheck.data.cli === "not_installed" ? "The GitHub CLI is still not found." : "The GitHub CLI is installed but not signed in yet."}</p>}
    </div>}
    {error && <p role="alert" className="fd-work-error">{error}</p>}
    {tokenOpen ? <form onSubmit={(event) => { event.preventDefault(); if (token.trim()) update.mutate({ token: token.trim() }, { onSuccess: () => setToken("") }); }}>
      <Input type="password" autoComplete="off" spellCheck={false} autoFocus aria-label="GitHub personal access token" placeholder="Personal access token" value={token} onChange={event => setToken(event.target.value)} />
      <Button type="submit" disabled={!token.trim() || update.isPending}>{update.isPending ? "Checking…" : "Connect"}</Button>
      <button type="button" className="fd-work-link" onClick={() => void host.openExternal("https://github.com/settings/tokens/new?scopes=repo,read:org&description=fabPlane")}>Create one</button>
    </form> : <button type="button" className="fd-work-link fd-work-connect-alt" onClick={() => setTokenOpen(true)}>Use a token instead</button>}
  </section>;
}

function AccountsMenu({ connection }: { connection: Connected }) {
  const { update, disconnect } = useWorkMutations();
  const watched = connection.owners.filter(owner => owner.watched).map(owner => owner.login);
  const toggle = (login: string) => update.mutate({ watched: watched.includes(login) ? watched.filter(item => item !== login) : [...watched, login] });
  return <WorkspaceMenu className="fd-work-accounts" label={<><Avatar actor={connection.viewer} size={18} /><span>{watched.length} {watched.length === 1 ? "account" : "accounts"}</span><Icon name="chevronDown" width={14} height={14} /></>}>
    <div className="fd-menu-caption">Watch repositories from</div>
    {connection.owners.map(owner => <label key={owner.login} className="fd-work-owner">
      <input type="checkbox" checked={owner.watched} disabled={update.isPending} onChange={() => toggle(owner.login)} />
      <Avatar actor={owner} size={18} /><span>{owner.login}</span>{owner.kind === "user" && <small>you</small>}
    </label>)}
    <div className="fd-menu-divider" />
    <div className="fd-menu-caption">Signed in as {connection.viewer.login} · {connection.source === "gh" ? "GitHub CLI login" : "saved token"}</div>
    <button onClick={() => disconnect.mutate()}><Icon name="close" width={16} height={16} />{connection.source === "token" ? "Forget saved token" : "Disconnect GitHub"}</button>
  </WorkspaceMenu>;
}

function AttentionList({ items, limit = 8, onShowAll }: { items: AttentionItem[]; limit?: number; onShowAll?: (() => void) | undefined }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <p className="fd-work-empty">Nothing is waiting on you.</p>;
  return <><ul className="fd-work-list">{(all ? items : items.slice(0, limit)).map(item => <li key={item.id}>
    <ExternalRow url={item.url} className="fd-work-row">
      <Icon name={item.kind === "pull_request" ? "route" : "checkCircle"} width={17} height={17} />
      <span className="fd-work-row-copy">
        <strong>{item.title}</strong>
        <small>{item.repo}#{item.number}{item.author ? ` · ${item.author.login}` : ""} · updated {ago(item.updatedAt)}{item.draft ? " · draft" : ""}</small>
      </span>
      <span className="fd-work-reasons">{item.reasons.map(reason => <Badge key={reason} tone={REASONS[reason].tone}>{REASONS[reason].label}</Badge>)}</span>
    </ExternalRow>
  </li>)}</ul>
  {!all && items.length > limit && <Button size="sm" variant="ghost" className="fd-work-show-more" onClick={onShowAll ?? (() => setAll(true))}>Show all {items.length}</Button>}</>;
}

function Feed({ events, limit = 40, onShowAll }: { events: WorkEvent[]; limit?: number; onShowAll?: (() => void) | undefined }) {
  const [shown, setShown] = useState(limit);
  const days = useMemo(() => {
    const groups: Array<{ day: string; events: WorkEvent[] }> = [];
    for (const event of events.slice(0, shown)) {
      const day = dayLabel(event.at), last = groups.at(-1);
      if (last?.day === day) last.events.push(event); else groups.push({ day, events: [event] });
    }
    return groups;
  }, [events, shown]);
  if (!events.length) return <p className="fd-work-empty">No activity in these repositories recently.</p>;
  return <>
    {days.map(group => <div key={group.day} className="fd-work-day">
      <h3>{group.day}</h3>
      <ul className="fd-work-feed">{group.events.map(event => <li key={event.id}>
        <ExternalRow url={event.url} className="fd-work-event">
          <Avatar actor={event.actor} />
          <span className="fd-work-row-copy">
            <span><b>{event.actor?.login ?? event.actorName ?? "Someone"}</b> {eventText(event)} <em>{event.title}</em></span>
            <small>{event.repo} · {new Date(event.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</small>
          </span>
        </ExternalRow>
      </li>)}</ul>
    </div>)}
    {events.length > shown && <Button size="sm" variant="ghost" onClick={onShowAll ?? (() => setShown(shown + 60))}>{onShowAll ? "Show all activity" : "Show older activity"}</Button>}
  </>;
}

function Team({ members, sinceDays, limit, onShowAll }: { members: TeamMember[]; sinceDays: number; limit?: number | undefined; onShowAll?: (() => void) | undefined }) {
  if (!members.length) return <p className="fd-work-empty">No one has been active in the last {sinceDays} days.</p>;
  const shown = limit ? members.slice(0, limit) : members;
  return <><ul className="fd-work-team">{shown.map(member => {
    const counts = [
      member.commits && `${member.commits} ${member.commits === 1 ? "commit" : "commits"}`,
      member.pullRequests && `${member.pullRequests} PR ${member.pullRequests === 1 ? "update" : "updates"}`,
      member.reviews && `${member.reviews} ${member.reviews === 1 ? "review" : "reviews"}`,
      member.issues && `${member.issues} issue ${member.issues === 1 ? "update" : "updates"}`,
    ].filter(Boolean).join(" · ");
    return <li key={member.login}>
      <div className="fd-work-member"><Avatar actor={member} size={28} /><span className="fd-work-row-copy"><strong>{member.login}</strong><small>Active {ago(member.lastActiveAt)} · {counts}</small></span></div>
      <ExternalRow url={member.latest.url} className="fd-work-member-latest"><span>Latest: {eventText(member.latest)} <em>{member.latest.title}</em></span></ExternalRow>
      {member.openPullRequests.slice(0, 3).map(pr => <ExternalRow key={pr.url} url={pr.url} className="fd-work-member-latest"><span>Open: <em>{pr.title}</em> · {pr.repo.split("/")[1]}#{pr.number}{pr.draft ? " · draft" : ""}</span></ExternalRow>)}
      {member.openPullRequests.length > 3 && <small className="fd-work-more">+{member.openPullRequests.length - 3} more open pull requests</small>}
    </li>;
  })}</ul>{members.length > shown.length && onShowAll && <Button size="sm" variant="ghost" className="fd-work-show-more" onClick={onShowAll}>Show all {members.length} people</Button>}</>;
}

type RepoAction = (url: string, purpose: "import" | "share") => void;

function Repositories({ scope, enabled, onImport }: { scope: WorkScope; enabled: boolean; onImport?: RepoAction | undefined }) {
  const repos = useWorkRepos(enabled);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const inScope = (repos.data?.repos ?? []).filter(repo => scope === "all" || repo.hardware);
  const needle = query.trim().toLowerCase();
  const matches = inScope.filter(repo => !needle || `${repo.fullName} ${repo.description ?? ""} ${repo.language ?? ""} ${repo.hardwareSignals.join(" ")}`.toLowerCase().includes(needle));
  const hardware = (repos.data?.repos ?? []).filter(repo => repo.hardware).length;
  const visible = all || needle ? matches : matches.slice(0, 12);
  return <section aria-label="Repositories">
    <div className="fd-work-heading"><h2>{scope === "hardware" ? "Hardware repositories" : "Repositories"}</h2>{repos.data && <span>{hardware} hardware of {repos.data.repos.length} scanned</span>}</div>
    {repos.isPending ? <p role="status" className="fd-work-empty"><Spinner /> Scanning repositories…</p> : repos.isError ? <p role="alert" className="fd-work-error">{errorText(repos.error)} <Button size="sm" variant="ghost" onClick={() => void repos.refetch()}>Try again</Button></p> : <>
      <label className="fd-home-search"><Icon name="search" width={18} height={18} /><Input aria-label="Find a repository" placeholder="Find a repository…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {!matches.length ? <p className="fd-work-empty">{needle ? "No repositories match." : scope === "hardware" ? "No hardware repositories found in the watched accounts. Switch to All repositories to see everything." : "No repositories in the watched accounts."}</p>
        : <ul className="fd-work-repos">{visible.map(repo => <RepoCard key={repo.fullName} repo={repo} onImport={onImport} />)}</ul>}
      {!all && !needle && matches.length > visible.length && <Button size="sm" variant="ghost" onClick={() => setAll(true)}>Show all {matches.length} repositories</Button>}
      {!!repos.data.truncated.length && <p className="fd-work-hint">Only the most recently pushed repositories were scanned for {repos.data.truncated.join(", ")}.</p>}
    </>}
  </section>;
}

function RepoCard({ repo, onImport }: { repo: WorkRepo; onImport?: RepoAction | undefined }) {
  return <li className="fd-work-repo-item">{onImport && <span className="fd-work-repo-actions">
    <Button size="sm" className="fd-work-repo-share" title={`Put ${repo.fullName} on the web for people you choose`} onClick={() => onImport(repo.url, "share")}><Icon name="share" width={14} height={14} />Share</Button>
    <Button size="sm" variant="ghost" className="fd-work-repo-import" title={`Copy ${repo.fullName} to this computer to work on it`} onClick={() => onImport(repo.url, "import")}><Icon name="download" width={14} height={14} />Import</Button>
  </span>}<ExternalRow url={repo.url} className="fd-work-repo">
    <span className="fd-work-repo-title"><Icon name={repo.hardware ? "pcb" : "folder"} width={16} height={16} /><strong>{repo.fullName}</strong>{repo.private && <Badge>Private</Badge>}{repo.archived && <Badge>Archived</Badge>}{repo.fork && <Badge>Fork</Badge>}</span>
    {repo.description && <span className="fd-work-repo-description">{repo.description}</span>}
    <small>{[repo.language, repo.pushedAt && `pushed ${ago(repo.pushedAt)}`, repo.hardware && `hardware: ${repo.hardwareSignals.slice(0, 3).join(", ")}`].filter(Boolean).join(" · ")}</small>
  </ExternalRow></li>;
}

function ProjectRow({ project, connection, onPublish }: { project: ProjectSummary; connection: Connected; onPublish: () => void }) {
  const link = useProjectGitHub(project.id);
  const { publish } = useWorkMutations();
  // The repository exists and is this project's remote, but nothing was pushed: offer to finish.
  const unpushed = link.data?.repo && !link.data.pushed ? link.data.repo : null;
  const finishPush = () => { const [owner = "", name = ""] = (unpushed?.fullName ?? "").split("/"); publish.mutate({ projectId: project.id, input: { owner, name } }); };
  return <li className="fd-work-project">
    <Icon name="folder" width={16} height={16} />
    <span className="fd-work-row-copy"><strong>{project.name}</strong><small>{link.isPending ? "Checking…" : publish.isError ? errorText(publish.error) : unpushed ? `${unpushed.fullName} · not pushed yet` : link.data?.repo ? link.data.repo.fullName : link.data?.otherRemote ? "Has another git remote" : "Only on this computer"}</small></span>
    {unpushed ? <Button size="sm" disabled={publish.isPending || !connection.canPublish} title="The repository was created but the push did not finish" onClick={finishPush}>{publish.isPending ? "Pushing…" : "Finish push"}</Button>
      : link.data?.repo ? <ExternalRow url={link.data.repo.url} className="fd-work-link" label={`Open ${link.data.repo.fullName} on GitHub`}>On GitHub<Icon name="externalLink" width={14} height={14} /></ExternalRow>
      : link.data && !link.data.otherRemote && <Button size="sm" disabled={!connection.canPublish} title={connection.canPublish ? "Create a GitHub repository for this project and push it" : "The GitHub token needs the repo scope to create repositories"} onClick={onPublish}>Move to GitHub</Button>}
  </li>;
}

function PublishDialog({ project, connection, onClose }: { project: ProjectSummary; connection: Connected; onClose: () => void }) {
  const { publish } = useWorkMutations();
  const { host } = useCore();
  const [owner, setOwner] = useState(connection.owners.find(item => item.watched && item.kind === "organization")?.login ?? connection.viewer.login);
  const [name, setName] = useState(suggestRepoName(project.name));
  const [isPrivate, setPrivate] = useState(true);
  const [description, setDescription] = useState("");
  const valid = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(name);
  const done = publish.data?.repo;
  return <Dialog open onClose={onClose} closeDisabled={publish.isPending} title={done ? "Project is on GitHub" : `Move “${project.name}” to GitHub`}>
    {done ? <div className="fd-work-publish">
      <p>Created <strong>{done.fullName}</strong> and pushed this project to it.</p>
      <div className="fd-work-publish-actions"><Button variant="primary" onClick={() => void host.openExternal(done.url)}>Open on GitHub</Button><Button onClick={onClose}>Done</Button></div>
    </div> : <form className="fd-work-publish" onSubmit={(event) => {
      event.preventDefault();
      if (valid) publish.mutate({ projectId: project.id, input: { owner, name, private: isPrivate, ...(description.trim() ? { description: description.trim() } : {}) } });
    }}>
      <p>fabPlane commits the project’s current files, creates the repository and pushes to it.</p>
      <label>Account<Select value={owner} onChange={event => setOwner(event.target.value)}>{connection.owners.map(item => <option key={item.login} value={item.login}>{item.login}</option>)}</Select></label>
      <label>Repository name<Input value={name} onChange={event => setName(event.target.value)} spellCheck={false} aria-invalid={!valid} /></label>
      {!valid && <p role="alert" className="fd-work-error">Use letters, numbers, dots, dashes and underscores.</p>}
      <label>Description (optional)<Input value={description} maxLength={350} onChange={event => setDescription(event.target.value)} /></label>
      <label className="fd-work-check"><input type="checkbox" checked={isPrivate} onChange={event => setPrivate(event.target.checked)} />Private repository</label>
      {!isPrivate && <p className="fd-work-hint">Anyone on the internet will be able to see this project’s files.</p>}
      {publish.isError && <p role="alert" className="fd-work-error">{errorText(publish.error)}</p>}
      <div className="fd-work-publish-actions"><Button type="submit" variant="primary" disabled={!valid || publish.isPending}>{publish.isPending ? "Publishing…" : `Create ${owner}/${name}`}</Button><Button onClick={onClose} disabled={publish.isPending}>Cancel</Button></div>
    </form>}
  </Dialog>;
}

function LocalProjects({ connection }: { connection: Connected }) {
  const projects = useProjects();
  const [publishing, setPublishing] = useState<ProjectSummary | null>(null);
  const [all, setAll] = useState(false);
  const list = (projects.data ?? []).filter(project => !project.isDraft).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <section aria-label="Your fabPlane projects">
    <div className="fd-work-heading"><h2>Your fabPlane projects</h2></div>
    {!list.length ? <p className="fd-work-empty">Projects you create appear here, ready to move to GitHub.</p>
      : <ul className="fd-work-projects">{(all ? list : list.slice(0, 6)).map(project => <ProjectRow key={project.id} project={project} connection={connection} onPublish={() => setPublishing(project)} />)}</ul>}
    {!all && list.length > 6 && <Button size="sm" variant="ghost" onClick={() => setAll(true)}>Show all {list.length} projects</Button>}
    {publishing && <PublishDialog key={publishing.id} project={publishing} connection={connection} onClose={() => setPublishing(null)} />}
  </section>;
}

function readScope(): WorkScope {
  try { return localStorage.getItem(SCOPE_KEY) === "hardware" ? "hardware" : "all"; } catch { return "all"; }
}

/**
 * What needs you, what changed and who is doing what, across GitHub. `compact` is the summary shown
 * under the projects on Home's Everything view; the full page adds repositories and local projects.
 */
export function WorkHub({ compact = false, onShowAll, onImportRepo }: { compact?: boolean; onShowAll?: () => void; /** Start importing a repository as a project, or sharing it on the web. */ onImportRepo?: RepoAction }) {
  const connection = useWorkConnection();
  const [scope, setScopeState] = useState<WorkScope>(readScope);
  const setScope = (next: WorkScope) => { setScopeState(next); try { localStorage.setItem(SCOPE_KEY, next); } catch { /* the choice just is not remembered */ } };
  const connected = connection.data?.connected ? connection.data : null;
  const overview = useWorkOverview(scope, !!connected);
  const { refresh } = useWorkMutations();
  const busy = refresh.isPending || overview.isFetching;
  const more = compact ? onShowAll : undefined;
  return <div className="fd-project-home fd-work-hub" data-testid="work-hub" data-compact={compact || undefined}>
    <header>
      <div>{compact ? <h2 className="fd-work-title">Work</h2> : <h1>Work</h1>}<p>{connected ? `Pull requests, issues and commits across ${connected.owners.filter(owner => owner.watched).map(owner => owner.login).join(", ") || "no accounts yet"}.` : "Everything going on across your team’s repositories, in one place."}</p></div>
      {connected && <div className="fd-home-actions">
        <div className="fd-work-scope" role="group" aria-label="Which repositories to show">
          <button type="button" aria-pressed={scope === "hardware"} onClick={() => setScope("hardware")}><Icon name="pcb" width={15} height={15} />Hardware</button>
          <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All repositories</button>
        </div>
        <AccountsMenu connection={connected} />
        <Button disabled={busy} title={overview.data ? `Updated ${ago(overview.data.fetchedAt)}` : "Refresh"} onClick={() => refresh.mutate(scope)}><Icon name="refresh" width={16} height={16} />{busy ? "Refreshing…" : "Refresh"}</Button>
      </div>}
    </header>
    {connection.isPending ? <p role="status" className="fd-work-empty"><Spinner /> Checking GitHub…</p>
      : connection.isError ? <EmptyState title="Could not check GitHub" action={<Button onClick={() => void connection.refetch()}>Try again</Button>}><span role="alert">{errorText(connection.error)}</span></EmptyState>
      : !connected ? <ConnectCard connection={connection.data as Extract<WorkConnection, { connected: false }>} />
      : <>
        {overview.isError && <p role="alert" className="fd-work-error">{errorText(overview.error)}</p>}
        <div className="fd-work-grid">
          <div>
            <section aria-label="Needs your attention">
              <div className="fd-work-heading"><h2>Needs your attention</h2>{overview.data && <span>{overview.data.attention.length} open</span>}</div>
              {overview.isPending ? <p role="status" className="fd-work-empty"><Spinner /> Loading…</p> : overview.data && <AttentionList key={String(compact)} items={overview.data.attention} limit={compact ? 4 : 8} onShowAll={more} />}
            </section>
            <section aria-label="Activity">
              <div className="fd-work-heading"><h2>Activity</h2>{overview.data && <span>Last {overview.data.sinceDays} days · {overview.data.repos.length} active {overview.data.repos.length === 1 ? "repository" : "repositories"}</span>}</div>
              {overview.isPending ? <p role="status" className="fd-work-empty"><Spinner /> Loading…</p> : overview.data && <Feed key={`${scope}:${compact}`} events={overview.data.feed} limit={compact ? 8 : 40} onShowAll={more} />}
            </section>
          </div>
          <aside>
            <section aria-label="Team">
              <div className="fd-work-heading"><h2>Team</h2></div>
              {overview.isPending ? <p role="status" className="fd-work-empty"><Spinner /> Loading…</p> : overview.data && <Team members={overview.data.team} sinceDays={overview.data.sinceDays} limit={compact ? 4 : undefined} onShowAll={more} />}
            </section>
            {!compact && <LocalProjects connection={connected} />}
          </aside>
        </div>
        {!compact && <Repositories scope={scope} enabled onImport={onImportRepo} />}
      </>}
  </div>;
}
