# fabPlane repository cutover

`fabPlane/fabdesk` starts with the complete `main` history and all 112 source tags
from `TensorFleet/fabdesk` at `4e980c47a084a98d6489408377bfe5499c735b05`.
Old issues, pull requests, releases, Actions runs and artifacts were not imported.
The private TensorFleet repository remains available until cutover is verified.

## Actions bootstrap

- Set `LINUX_RUNNER=github-hosted` until an owned Linux runner is registered for
  this repository. Fork PRs always use GitHub-hosted Ubuntu. Existing NAS and
  Blacksmith overrides remain available.
- macOS defaults to GitHub-hosted Apple Silicon (`macos-15`); Intel packaging
  uses `macos-15-intel`. Windows uses `windows-2025`. A freshly registered shared
  Mac can still be selected using its capacity variables and reservation ref.
- Copy static configuration for CLI sync and the TraceMaker downloads bucket.
  Do not copy heartbeat timestamps from another repository. The monitoring
  service must target this repository before enabling owned-runner routing.
- Configure the required Actions credentials through GitHub Secrets. Never put
  their values in Git, issue bodies, command arguments or logs.
- Contributor builds use public submodules only. The private website workspace has
  been removed, TypeScript settings are local, and no submodule deploy key is needed.
- CI runs uniquely named Core verification, Secret scan and TraceMaker checks.
  Forks use hosted runners without signing or deployment credentials.

The core and desktop release base is `0.4.0`. A new Actions run counter must not
produce versions below the existing `0.3.x` releases.

The issue fingerprint ledger starts empty for the new tracker. Historical issue
numbers must not deduplicate or close unrelated issues in this repository.

## Release cutover

Keep `RELEASE_PUBLISHING_ENABLED=false` during setup. Internal manual builds
remain available; public/nightly releases are gated off.

Before enabling public releases:

1. Verify CI, mobile checks and the hosted Mac toolchain in the new repository.
2. Verify signing and a manual internal installer build without publishing.
3. Update the website's `desktop-release-status.ts` and
   `publish-desktop-release.ts` source-repository configuration from
   `TensorFleet/fabdesk` to `fabPlane/fabdesk`, and authorize its release-read
   credential for the new repository. This is a separate website change.
4. Stop the old repository's scheduled publishers before enabling the new
   release and TraceMaker publishers. Do not let both repos publish to the same
   download feed or storage prefix.
5. Enable `RELEASE_PUBLISHING_ENABLED=true` only at the agreed cutover, then
   validate a signed release, website handoff and installer download.
6. Archive `TensorFleet/fabdesk` after the handoff is verified.

## Public switch and main protection

Keep the repository private until the owner chooses to publish. The current
organization plan rejects private branch protection with HTTP403. The owner chose
to defer enforcement until the public switch rather than upgrade the plan.
Immediately after making the repository public, run from this checkout:

```sh
bash scripts/protect-main.sh
```

This applies the reviewed `.github/main-protection.json`: PRs, up-to-date passing
Core verification / Secret scan / TraceMaker checks, resolved conversations,
administrator enforcement, no force pushes or main deletion, and approval for
all external-contributor workflows once public. Approving-review
count starts at zero so a sole maintainer can use PRs; increase it once independent
reviewers are available. The API command never changes visibility or billing.
Verify the returned checks and the rule in GitHub Settings before accepting code.

## Source preparation

Original FabDesk source in this repository is licensed under Apache-2.0. See
`LICENSE` and `NOTICE` for the license and attribution, and review
`THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md` and `SECURITY.md` before public switch.
Separately licensed source/assets keep their original terms.
The FabPlane PCB/CAD submodules are public but have no root license at the pinned
revisions; this repository's license does not relicense them. Owners should settle
those upstream license declarations before redistributing their source or binaries
outside existing grants. Bundled engine and router notices/source obligations
remain independent.

The full imported history/tags were scanned with Gitleaks8.30.1. Five findings were
reviewed as an RFC WebSocket test key, two documented development-token examples,
and two Firebase Android client configuration entries. `.gitleaksignore` records
only those exact historical fingerprints; new occurrences still fail. The scanner
redacts output. Historical internal staging hostnames and deliberately public
seed-account examples are context, not credentials for production. Production
password login remains blocked and covered by client request-boundary tests.
Firebase service restrictions/security rules remain the cloud owner's responsibility;
this source audit does not prove cloud-console configuration.

Experimental iOS/EAS acceptance is not required for desktop publication and remains
deferred when its external credentials or provisioning are unavailable. Do not
claim App Store, notarization or Windows SmartScreen acceptance from source tests.
