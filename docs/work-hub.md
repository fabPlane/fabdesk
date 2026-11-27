# Work hub

Home › **Work** shows what is going on across a GitHub account's repositories: what needs the
signed-in person, a feed of commits / pull requests / issues / reviews, what each team member is
doing, the repositories themselves, and local fabPlane projects that can be moved to GitHub.

Everything runs in the local core (`apps/core/src/work-hub.ts`, routes in
`apps/core/src/http/work-routes.ts`, shapes in `packages/protocol/src/work-hub.ts`, page in
`packages/ui/src/work/`). Nothing goes through fabplane.com.

## Connection

The core uses, in order: a personal access token saved from the Work page
(`${FABDESK_HOME}/github.json`, 0600), then the GitHub CLI login (`gh auth token`). The token never
reaches the renderer or a paired device. Scopes: `repo` and `read:org`; without `repo` the hub is
read-only and **Move to GitHub** is disabled.

**Watched accounts** decide what is scanned. Until the person chooses, that is their own account
plus the organizations they committed to in the last year: membership alone is not used, because one
very large organization would bury everything else. The choice is saved next to the token.

## What is read

| Part | Source | Limits |
| --- | --- | --- |
| Repositories | GraphQL `repositoryOwner.repositories` per watched account | 200 most recently pushed per account; cached 5 min |
| Hardware flag | languages (three largest), topics, names at the top of the default branch | no file contents are read; see `hardwareSignals` |
| Needs attention | three searches: review requested, own open pull requests (failing checks, conflicts, changes requested, approved), assigned | 40 / 60 / 40 newest; cached 2 min |
| Activity, team | the 20 most recently pushed unarchived repositories in scope: default-branch commits, pull requests, reviews, issues | last 14 days; 200 newest events; cached 2 min |

The **Hardware / All repositories** switch narrows all of it to repositories with a hardware
signal. Bots and commits whose author has no GitHub account appear in the feed but not under Team.
**Refresh** bypasses the caches.

## Moving a project to GitHub

`POST /projects/:id/github` commits the project folder (the same commit Finish it makes), creates
the repository under the chosen account (private by default), adds it as `origin` and pushes. The
token is passed to git through its environment (`http.https://github.com/.extraheader`), never in
arguments or the saved remote URL. A project that already has an `origin` is left alone.

Changing the connection and publishing need the local desktop connection; the remote listener
answers 403. Reads are available to paired devices.

## Not yet

Linear, a "Sign in with GitHub" button (OAuth device flow), webhooks / push updates (the page
polls), importing a private repository as a project, notifications for new attention items, and
the mobile client.
