# Contributing to fabPlane

Work in `fabPlane/fabdesk`. The archived TensorFleet repository preserves earlier
issues and PR discussions; new development and bug reports belong here.

## Build and verify

Install Bun 1.4.x, Node 22 and Git. Clone with public submodules:

```sh
git clone --recurse-submodules https://github.com/fabPlane/fabdesk.git
cd fabdesk
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build:desktop
bun run dev
```

No organization membership, website-backend checkout or deployment secret is
required. Development uses an isolated desktop identity; it preserves installed-app
data. Native board generation requires the FabPlane PCB bridge and an API-capable
KiCad build; see [docs/dev-loop.md](docs/dev-loop.md) and
[docs/fab-pcb-migration.md](docs/fab-pcb-migration.md). Missing optional engines must
report an unavailable capability rather than claim successful execution.

`bun run test` selects project workspaces. Do not use bare `bun test` at the root,
which also discovers unrelated vendor tests. Do not install inside submodules.
The experimental mobile app has a separate lockfile: use `bun run mobile:install`,
`bun run mobile:typecheck` and `bun run mobile:test` from the root.

## Pull requests

Create a short-lived branch and target `main`. Explain the concrete problem,
resulting behavior and checks actually run. Include real before/after captures for
visible changes when possible, using disposable data. Never commit credentials,
user projects, local database dumps, signing material or generated source maps.
Preserve third-party license notices and attribution.

Fork checks run without signing/deployment credentials on isolated hosted runners.
Signing, notarization and publishing are maintainer-only release operations; a
contributor should not need access to them to submit a change.

Use issues for reproducible bugs and focused proposals. Include the app version,
OS, expected/actual result and safe reproduction steps. Remove private board
files, paths and tokens before attaching logs. Use the security reporting process
for vulnerabilities instead of a public issue.
