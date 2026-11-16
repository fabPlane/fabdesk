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
- The website workspace remains private at `TensorFleet/fabplane.com`; its URL
  is absolute so moving this repository does not change its resolution. Full
  CI still needs `FABDESK_SUBMODULE_SSH_KEY`. Public fork builds require a
  separate dependency extraction; no private credential is exposed to forks.

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

The retained private workspace and historical commit contents still need an
open-source review before changing the new repository's visibility to public.
