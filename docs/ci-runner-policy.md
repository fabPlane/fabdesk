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
switch runners dynamically; cancel/re-run after setting an outage override if
needed.

Blacksmith is used only when no fresh idle evidence exists and the repository
variable `NAS_RUNNER_OUTAGE_UNTIL` holds a future Unix timestamp within 15 minutes
of selection. Confirm an actual NAS/service outage independently before setting
it. Fresh idle evidence overrides the outage lease. This variable is not
currently populated by an automated health monitor, and no new access is
requested by the workflow. It is an explicit recovery override, not reliable
automatic outage detection.

## Manual recovery using existing repository administrator access

After confirming an outage, set the variable in GitHub repository Settings →
Secrets and variables → Actions → Variables. Use a Unix timestamp five minutes
in the future. Alternatively, from an existing authenticated administrator shell:

```sh
outage_until=$(( $(date +%s) + 300 ))
gh variable set NAS_RUNNER_OUTAGE_UNTIL --repo TensorFleet/fabdesk --body "$outage_until"
```

After recovery, set the variable to `0` to disable the override:

```sh
gh variable set NAS_RUNNER_OUTAGE_UNTIL --repo TensorFleet/fabdesk --body 0
```

No override was set as part of preparing this change. The lease limits how long
new jobs may be routed to Blacksmith; it does not cancel already-running jobs
or guarantee a monetary cap. A fresh selector can choose NAS after recovery.


## Validate the policy

Run `python3 scripts/test-runner-selection.py` to exercise the workflow shell
against idle, busy/stale, missing signals, outage lease boundaries and fork
isolation. Validate workflow expressions and job dependencies with actionlint.

## Tools on ephemeral Linux workers

NAS jobs must configure the tools they use instead of assuming the hosted image
contains them. Release version metadata uses the configured Bun runtime. Release
and security jobs install GitHub CLI 2.102.0 from its official Linux X64 archive,
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
