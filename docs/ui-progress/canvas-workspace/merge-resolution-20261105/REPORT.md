# Merge resolution — November 5, 2026

PR #389 now incorporates `origin/main` at `d2c24aa`, including the merged enclosure PR #398. The nine content conflicts were reconciled using the already reviewed PR #420 integration merge as a reference, preserving both canvas source/revision guards and the enclosure engine. Protocol/client exports and CSS/module declarations retain both sides. The GLB exporter retains imported model-directory handling, valid-file checks, isolated temporary exports, and mechanical coordinates. MCP inventory assertions test required tools and per-session isolation without hard-coding a stale count.

Removed duplicate `three`/`@types/three` manifest keys introduced by the automatic merge. Updated the imported-model CLI mock to emit a valid GLB and record arguments outside the exporter's temporary directory; the previous text-only mock failed the new GLB validation.

Validation at this merge:

- Root typecheck: passed.
- UI suite: 365 passed, 0 failed.
- Registry, board scope, member model and daemon HTTP checks: 92 passed, 1 skipped, 0 failed with loopback access and a 30-second subprocess allowance. The first sandbox run could not bind loopback and two native subprocess tests exceeded five seconds; the unrestricted rerun passed.
- Imported model arguments, GLB integrity and model receipts: 14 passed, 0 failed after correcting the mock.
- Desktop production build: passed; no packaged `.map` files.

No new human walkthrough is claimed for the merge itself. The separately recorded connection-form walkthrough on PR #420 remains the UI evidence. PR #420 still carries the canvas-specific Mechanical organization and source-scoping follow-ups; this conflict resolution does not assert whole-app or engineering readiness. Existing native SVG fixtures from main retain their original trailing whitespace.
