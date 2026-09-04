# Daily jobs

Two scheduled jobs keep security findings and open PRs from going stale.

| Job           | Where it runs                                                                               | What it does                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Security scan | GitHub Actions (`.github/workflows/security-scan.yml`) plus this Grok Cloud Agent           | Combs fabPlane-native source and `bun audit`, opens GitHub issues, skips duplicates |
| PR relevance  | This Grok Cloud Agent (`https://cursor.com/agents/bc-084626c9-7019-46ea-a3e7-7d5f02ecea66`) | Reviews every open PR and pages you here when the PR is still relevant             |

## Security scan

Schedule: **13:00 UTC** every day (`0 13 * * *`) once this workflow is on `main`, on every pull request, and via **Run workflow** in the Actions tab.

The Action:

1. Installs dependencies the same way CI does (fabplane submodule + `bun install --frozen-lockfile`).
2. Runs `bun run scripts/security-scan.ts --json` — `bun audit` plus a conservative walk of `apps/`, `packages/`, `scripts/`, `.github/`. `vendor/`, fixtures, and generated dirs are skipped.
3. Syncs high/critical findings to issues via `scripts/security-issues.ts`.

### Dedup

Each finding has a 16-hex fingerprint (rule + package/id, or rule + file + line). The issue body starts with:

```
<!-- fabdesk-security-fingerprint: deadbeefcafebabe -->
```

On later runs:

- Same fingerprint, **open** issue → skip (already filed).
- Same fingerprint, **closed** issue → skip (treated as dismissed; we do not reopen).
- Same **title** as an open issue that predates fingerprints → skip.
- Severity below `--min-severity` (default `high`) → skip.

Durable dedup is `.github/security-filed.json` (fingerprint → issue). The Actions `GITHUB_TOKEN` on `pull_request` can create issues but `gh issue list` returns empty, so a label/list-only check is not enough.

Scheduled and `workflow_dispatch` runs commit ledger updates back to the branch they ran on (`contents: write`) so a later run that still cannot list issues will not open a second copy.

The first Action run opened [#7](https://github.com/TensorFleet/fabdesk/issues/7)–[#20](https://github.com/TensorFleet/fabdesk/issues/20). A second run opened duplicates #21–#34; those are now closed as duplicates of #7–#20. Pull requests dry-run creates. The GitHub cron is live only after this workflow exists on `main`.

Labels: `security`, `security-scan`. Do not remove the HTML comment if you edit the issue.

### Local

```bash
bun run security:scan
bun run security:scan -- --json --out findings.json
bun run security:issues -- --findings findings.json --dry-run
```

This Cloud Agent's `gh` token cannot create issues. Filing happens in Actions with `issues: write`.

## PR relevance → Grok bot

Schedule: **13:30 UTC** every day, as a timer on this Grok conversation (Cloud Agent timers expire after about a week — recreate them here or promote to a Cursor Automation). When it fires, the agent:

1. Fetches `main` and lists open PRs (`bun run pr:relevance` / `gh pr list`).
2. Reads each PR (description, diff vs `main`, CI, review state).
3. Decides whether the change is still relevant (not superseded, not bit-rotted beyond repair, still matches current architecture).
4. **Notifies in this Grok conversation** — a short digest of relevant PRs, plus a quiet list of idle drafts / abandoned ones. No GitHub comment spam.

Classification used as a first pass (`scripts/pr-relevance.ts`):

| Class             | Notify? | Rule of thumb                                  |
| ----------------- | ------- | ---------------------------------------------- |
| `active`          | yes     | Updated in the last 2 days, mergeable          |
| `stale`           | yes     | Quiet 3–6 days, still mergeable                |
| `needs-attention` | yes     | Quiet ≥7 days, or behind / conflicts / blocked |
| `draft-idle`      | no      | Draft with no update for 7+ days               |
| `abandoned`       | no      | Non-draft with no update for 21+ days          |

The Grok pass can override the heuristic after reading the diff (for example a 3-day-old PATH fix is still relevant; a password-login PR is blocked on a fabplane deploy).

```bash
bun run pr:relevance
bun run pr:relevance -- --json
```

## Grok Cloud Agent timers (this conversation)

Timers expire after about a week. Re-arm from this chat (`cursor-subscriptions` `subscribe_timer`; unsubscribe first to change a prompt). Canonical prompts:

**daily-security-scan** — cron `0 13 * * *`

```
Daily security scan for TensorFleet/fabdesk (docs/daily-jobs.md). THIS conversation is the Grok bot channel (https://cursor.com/agents/bc-084626c9-7019-46ea-a3e7-7d5f02ecea66).

1. Put bun on PATH if needed (`export PATH="$HOME/.bun/bin:/usr/local/bin:$PATH"`). Fetch origin/main.
2. Confirm `.github/workflows/security-scan.yml` exists on origin/main. If missing, say filing is blocked on merging https://github.com/TensorFleet/fabdesk/pull/6 and continue the digest anyway.
3. Run `bun run security:scan -- --json --out /tmp/fabdesk-security-findings.json`.
4. Dedup against `.github/security-filed.json` (not `gh issue list` — this token cannot read issues). Run `bun run security:issues -- --findings /tmp/fabdesk-security-findings.json --ledger .github/security-filed.json --dry-run`.
5. Short agentic review of apps/core auth/HTTP/MCP, packages/auth-client, packages/tools/src/fs.ts, desktop IPC/CSP.
6. Digest HERE: new findings vs the ledger, already-filed #7–#20, scanner misses. Do not `gh issue create`. Filing is the GitHub Action on main (13:00 UTC) or workflow_dispatch.
7. Re-arm: list_subscriptions. If daily-security-scan, daily-pr-relevance, or rearm-daily-jobs expire within 3 days or are missing, unsubscribe them and subscribe again with the prompts in this file.
8. Do not open a PR unless asked. Stop after the digest.
```

**daily-pr-relevance** — cron `30 13 * * *`

```
Daily open-PR relevance review for TensorFleet/fabdesk. THIS conversation is the Grok bot notification channel (docs/daily-jobs.md).

1. Put bun on PATH if needed. Fetch origin/main.
2. Run `bun run pr:relevance -- --json` and `gh pr list --state open`.
3. For each open PR, read the description, latest commits, CI, and whether the diff still applies against origin/main (mergeable, behind, conflicts, superseded).
4. Notify HERE for every PR that is still relevant: number, title, URL, one-sentence why it still matters, any blocker. List idle drafts / abandoned PRs briefly without paging.
5. Re-arm timers if they expire within 3 days (prompts in this file).
6. Do not comment on the PRs, do not merge, do not open new PRs. Stop after the digest.
```

**rearm-daily-jobs** — cron `0 12 * * 0`

```
Re-arm Fabdesk daily Grok jobs so they outlive the 7-day timer expiry (docs/daily-jobs.md).

1. Call list_subscriptions.
2. For each of daily-security-scan, daily-pr-relevance, and rearm-daily-jobs: if missing or expires within 4 days, unsubscribe then subscribe with the exact prompts and crons in docs/daily-jobs.md.
3. Confirm all three are active and report expiresAt HERE.
4. Do not open a PR. Do not file issues. Stop after confirming.
```

## Durable Cursor Automations

Timers on this conversation expire with the agent run. For a job that outlives this chat, create two automations at [cursor.com/automations](https://cursor.com/automations) against `TensorFleet/fabdesk`, model Grok, daily cron:

**Security (agentic pass)** — cron `0 13 * * *`, repository attached. Prompt: run `bun run security:scan`, list open `security-scan` issues, review `apps/core` auth/HTTP/MCP and `packages/auth-client` / `packages/tools/src/fs.ts` for anything the scanner missed, and report a digest in the run. Do not open a PR unless asked. Do not file issues from the agent (`gh` is read-only); rely on the GitHub Action.

**PR relevance** — cron `30 13 * * *`, repository attached. Prompt: run `bun run pr:relevance`, read every open PR, decide relevance vs current `main`, and write a digest in the run (this is the Grok bot notification). Do not comment on the PRs unless asked.

## First-pass rules the scanner looks for

- `bun audit` advisories (all severities in the report; only high/critical become issues by default)
- PEM private keys, `ghp_` / `github_pat_` tokens, `AKIA…` keys, Slack `xox*` tokens
- Hard-coded `password` / `secret` / `api_key` / `token` assignments of 20+ chars (placeholders like `changeme` / `your-token-here` are ignored)
- `eval(` / `new Function(` in TS/JS
