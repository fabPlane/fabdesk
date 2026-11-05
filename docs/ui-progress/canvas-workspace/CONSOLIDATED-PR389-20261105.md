# Consolidated delivery in PR #389 · 5 November 2026

The owner requested one PR for the full canvas workspace rather than a separate Mechanical integration PR. `feat/sketch-first-drafts` was fast-forwarded from `121c2ad` to `120acc4`, preserving every commit and the exact tree previously on `feat/canvas-mechanical-integration` / PR #420. No conflict resolution, cherry-pick or history rewriting was needed.

PR #389 is the delivery PR for Home/idea drafts, board and placement workflows, Mechanical/enclosure integration, connection guidance, shared workspace bars and the 0.3 version baseline. PR #420 is superseded and closes without merging to main; its branch and evidence remain preserved. Future work in this checkout continues on `feat/sketch-first-drafts`.

The content transferred is the already validated `120acc4` tree. Version/release tests: 13 passed. Desktop production build: passed in 25.16 seconds, zero packaged source maps. The toolbar checkpoint passed UI typecheck and 366 UI tests. Consolidation changes documentation only beyond that tree; it does not require repeating identical runtime checks or establish new human-test coverage.

Release behavior is documented in [releases](../../releases.md): checked-in app version 0.3.0; public versions remain 0.3.<workflow run number>. Neither this consolidation nor a PR merge publishes a release automatically.

Acceptance limitations remain in the detailed reports: [Mechanical](mechanical-integration-20261104/REPORT.md), [connection guidance](connection-guidance-20261105/REPORT.md), and [menu bars](menu-bars-20261105/REPORT.md). Final narrow-window/all-page toolbar capture, native model imports, broader CAD/platform acceptance, physical/electrical compatibility and real manufacturing readiness are not newly verified by moving branches. Hosted CI is separate from local results.

No PR merge, release tag, deployment, order or payment is performed by this consolidation.
