# Owned runners and outage fallback

Linux work prefers the repository's existing ephemeral tf-nas label set. Fork PR
validation in workflows using this selector remains on isolated GitHub-hosted
Ubuntu. There is no checkout in the selector itself.

The reusable selector runs once on `ubuntu-latest`; it no longer launches paid
Blacksmith settle/select jobs. This requires GitHub-hosted Actions allowance.
If that allowance is exhausted, selection cannot run even when NAS is healthy.
An always-available control runner or a reviewed alternative is needed to remove
that dependency; this change does not create a new runner or credential.

## What is a fallback?

`NAS_RUNNER_HEARTBEAT` is an idle heartbeat. A timestamp no more than 20 seconds
old proves recent idle capacity. A busy worker stops publishing the heartbeat,
so stale, missing, malformed or future timestamps do **not** prove an outage.
Those states queue work on owned runners. Work already queued on NAS cannot
switch runners dynamically; cancel/re-run after setting an override if needed.

Blacksmith is selected for trusted (non-fork) work in two cases:

1. **Durable override** — repository variable `FORCE_BLACKSMITH_LINUX` is a
   truthy value (`true`, `1`, `yes`, or `on`), or `LINUX_RUNNER` is
   `blacksmith`. This stays in effect until an administrator unsets it or sets
   a non-matching value. Fresh idle evidence does **not** override it. Use this
   when the NAS host is offline for a long stretch or is missing libraries.
2. **Bounded lease** — no fresh idle evidence exists and `NAS_RUNNER_OUTAGE_UNTIL`
   holds a future Unix timestamp within 15 minutes of selection. Fresh idle
   evidence overrides this lease.

Fork PRs stay on isolated GitHub-hosted Ubuntu in every case.

Listing whether a self-hosted NAS runner is online needs Administration scope.
`GITHUB_TOKEN` cannot read that API, and this workflow does not add a
credential. There is no automatic "no online NAS runner" probe. Use the durable
override when the host is down.

`NAS_RUNNER_OUTAGE_UNTIL` is not currently populated by an automated health
monitor. It is a short recovery override, not reliable automatic outage
detection.

No override is set by preparing this change.

## Durable Blacksmith override

Set the variable in GitHub repository Settings → Secrets and variables →
Actions → Variables. Alternatively, from an existing authenticated
administrator shell:

```sh
gh variable set FORCE_BLACKSMITH_LINUX --repo TensorFleet/fabdesk --body true
```

`LINUX_RUNNER=blacksmith` is equivalent:

```sh
gh variable set LINUX_RUNNER --repo TensorFleet/fabdesk --body blacksmith
```

Restore the default NAS path by unsetting the variable or setting a
non-matching value:

```sh
gh variable set FORCE_BLACKSMITH_LINUX --repo TensorFleet/fabdesk --body false
gh variable set LINUX_RUNNER --repo TensorFleet/fabdesk --body ""
```

The durable override does not cancel already-running jobs. Re-run queued NAS
jobs after setting it if those jobs must move.

## Bounded outage lease

After confirming a short outage, set `NAS_RUNNER_OUTAGE_UNTIL` to a Unix
timestamp five minutes in the future:

```sh
outage_until=$(( $(date +%s) + 300 ))
gh variable set NAS_RUNNER_OUTAGE_UNTIL --repo TensorFleet/fabdesk --body "$outage_until"
```

After recovery, set the variable to `0` to disable the lease:

```sh
gh variable set NAS_RUNNER_OUTAGE_UNTIL --repo TensorFleet/fabdesk --body 0
```

The lease limits how long new jobs may be routed to Blacksmith; it does not
cancel already-running jobs or guarantee a monetary cap. A fresh selector can
choose NAS after recovery. Prefer the durable override when the outage will
last longer than 15 minutes.

## Validate the policy

Run `python3 scripts/test-runner-selection.py` to exercise the workflow shell
against idle, busy/stale, missing signals, the durable override, outage lease
boundaries and fork isolation. Validate workflow expressions and job
dependencies with actionlint.

## Tools on ephemeral Linux workers

The main CI and mobile verification jobs install Bun 1.4.0 with `oven-sh/setup-bun`. If that
step fails, it downloads the same Linux X64 release archive through GitHub's
release asset API, checks its pinned SHA256, and adds the extracted binary to
the job's PATH. A failed download or checksum still fails CI. This handles the
release download edge returning HTTP 504 without changing the Bun version or
disabling tests. The tool setup regression check exercises the actual fallback
and rejects corrupted archives and unsupported architectures.

NAS jobs must configure the tools they use instead of assuming the hosted image
contains them. Release version metadata uses the configured Bun runtime. Release
and security jobs install GitHub CLI 2.102.0 from its official Linux X64 archive
through the GitHub release asset API,
verify the pinned SHA256, and add only the job's temporary directory to PATH.
This requires no sudo, runner image change, or new credential. The release step
is shared with YAML aliases so the website handoff can keep its empty token
permissions and avoid a checkout.

Run `bun run scripts/test-ci-tools.ts` to exercise the actual workflow commands
with Node and gh absent from PATH. It checks version outputs, the verified
archive, all release consumers, rejection of a corrupt archive, and unsupported
architectures. On Linux it also executes the installed CLI's version command;
on other platforms it verifies the Linux binary without executing it. The test
never creates issues, releases, or workflow dispatches.

## CI control tests

The main CI workflow runs Linux selector regression tests and the shared Mac
selector/job-hook tests at the beginning of `verify`, before private submodule
checkout. They reuse its owned-first Linux allocation rather than starting
separate GitHub-hosted or Blacksmith jobs. Node 22 is provided per job because
the minimal NAS image does not include Node. The reusable routing bootstrap
stays on GitHub-hosted Ubuntu so NAS unavailability cannot prevent fallback,
and fork PRs still select GitHub-hosted Ubuntu rather than an owned runner.

The standalone TraceMaker scripts job continues to require CMake, a C compiler
and `ar` on GitHub-hosted Ubuntu. These tools are absent on the minimal NAS
image; its optional TraceMaker check in `verify` does not replace that gate.
Native macOS, Windows and ARM builds keep their existing selectors.
