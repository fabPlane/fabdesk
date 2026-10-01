# GUI review

The review stack: [visual refresh #200](https://github.com/TensorFleet/fabdesk/pull/200),
[search/timestamps #206](https://github.com/TensorFleet/fabdesk/pull/206),
[project locations/import #207](https://github.com/TensorFleet/fabdesk/pull/207), and
[composer queue #208](https://github.com/TensorFleet/fabdesk/pull/208).
No backend changes belong to #200. No PR has been merged.

## Capture revisions — September 30, 2026

- Fetched current main baseline: `263a38d2c8dc478eb309ed18d7fcda4a38daf67d`.
- Visual-only capture: `22676bbccd72d8422c71bb096abe26704ce8c95f`.
- Feature captures from the complete stack: `db98b45431ff4fda64888054bc09fdad23c6ef1a`.
- Search/import heads at initial fetch: `b8f4a692463a42dfc0c5d86494183c28826e1d75` /
  `e08349ee243d367d45c361e4061dc3ff4bafe2f2`.
- Subsequent import cancellation fix: `02bb2c4b79c5061f7da537ba9249c5dd96225cf8`,
  propagated to the complete stack as `c125188848aeaa779acd6a219082f6a0c7a0623e`.
  Feature images precede that backend-only fix; they are not captures of the later head.
  This report is a subsequent documentation change.

Fresh native Electron renderer captures replace the historical comparisons in #200.
All images are GitHub PR attachments, not repository binaries. Main is on the left,
visual-only UI on the right: new chat and selected project/PCB at 1440×920, narrow
board at 960×600, and Appearance settings at both sizes. #206–#208 embed their own
feature evidence. Upload previews were checked for loaded images and dimensions.

Each pair uses the same isolated profile and disposable data, Fabplane Dark theme,
selected project/thread/board state, and measured pane widths. Wide pane proportions
are 16.6667/43.3333/40%; narrow proportions are 20/50/30%. There is no active chat in
the comparison pairs. Project captures show the same imported PicoMemcard PCB.
The public fixture revision is `9ea646810366574740b03e3211b655de870a03dc`
from `dangiu/PicoMemcard`, board `pcb/PicoMemcard-pico/PicoMemcard-pico.kicad_pcb`.

Environment: macOS 26.6.2 (25G83), arm64, Electron 44.1.1, Bun 1.4.0,
KiCad 10.0.4. Native windows were sized to 1440×920 or 960×600. Retina renderer
captures were scaled to CSS dimensions. **These images omit OS window chrome**;
they are not proof of traffic-light or title-bar behavior. Separate native inspection
was limited by the macOS sharing overlay and control-tool failures.

## Native verification

- Command-comma opens Settings; Escape closes it and returns focus to the composer.
  Keyboard traversal remains inside Settings. Shift-Tab from Close wraps to the last
  enabled control, Tab wraps back to Close, and Escape restores composer focus.
- Selected and saved all four themes. Command-1 through Command-8 opens all eight
  board views at minimum size. Empty/loading/local-sign-in states were exercised;
  this is not validation of every CAD operation or authenticated shopping flow.
- Long labels truncate at 960×600; comparison pages have no horizontal document
  overflow. Refreshed settings Save/Reset controls remain visible at minimum size.
  Native mouse resizing also passed with Retina-pixel coordinates: board width
  changed 431.40 → 531.26 px at 1440×920, and 353.92 → 304.03 px at 960×600,
  with no horizontal document overflow.
- Expanding a different project preserves the active chat. Ordering preserves the
  board pane, including with a rendered imported PCB.
- Native parent-folder picker and project creation succeeded with a custom location;
  `/tmp` resolved to `/private/tmp`. Canonical-path custom-location coverage passed.
- Literal `R[1]` search issued one request after about 260 ms. Result navigation
  selected the chat; the temporary highlight appeared and cleared after 2.8 seconds.
  September 29/30 date dividers and local message timestamps were visible.
- Disposable mock agent: queue acceptance, queued-item cancellation without stopping
  the active run, and Command-period stop followed by queued dispatch passed.
  Simulated send failure retained both draft text and attachment. No paid model run
  was needed; all mock runs were stopped.
- Public Hello-World import exercised zero boards; PicoMemcard exercised multiple
  boards and adoption. Missing-repository failure and real HTTP cancellation cleanup
  were checked. Native one-board automatic import also passed using `nayaramadan/BlinkyBoard`
  at `5ac1154f1d8208550dfa99a52249853530c26cb4`: the board was adopted and rendered
  without a chooser.

## Reproducible fix

Cancellation originally rejected on the Git child's AbortSignal error before the
child had exited. Cleanup could race with Git recreating the destination. #207 now
waits for child close before rejecting and deleting the destination; #208 contains
the same fix. A deterministic POSIX regression failed before the change and passed
afterward (4 import tests, 24 assertions). Real canceled-import cleanup was retested:
no destination remained and no project was registered.

## Test results and remaining gates

Required Bun 1.4.0 was used. Root `bun run typecheck` and root `bun run test`
now both pass on the complete stack, including the scripts phase. Mechanical tests:
18 pass / 250 assertions; full KiCad workspace: 48 pass; core: 291 pass / 2 optional
skips. Desktop builds passed on main, visual-only, and the complete stack.

The initial six macOS failures were independently reproduced on current main.
The import layer corrected canonical-path expectations for ephemeral project copies.
It also adds a stable-format mechanical runtime fixture with the same 13 footprints,
models, placements and expected measurements. The original KiCad 10.99 transform
fixture remains unchanged for parser coverage. Real GLB export now runs on installed
KiCad 10.0.4 with all measurement assertions intact. The concurrent-change wrapper
uses portable `sed` output plus rename instead of GNU-only `sed -i`. No failure was
silenced by skipping tests or weakening expected measurements.

An initial tools route test also failed once waiting for `route.done`; its focused
rerun and the final full tools suite passed. Its intermittent cause is unresolved.
The final UI suite passed 76 tests and desktop passed 92. The final successful
root command also ran its scripts phase: 71 pass, 0 fail.

A continuation verified unobscured traffic-light spacing, green full-screen entry,
Control-Command-F return, yellow minimize (hidden visibility and lost focus), and
restore. Native pane dragging subsequently passed using Retina-pixel coordinates.
Native title-bar movement was manually confirmed by the user on September 30, 2026:
dragging the empty top-bar area moves the entire window normally. Automation alone
could not verify this because its move event released the mouse button. The red
close control was verified: the native bridge reported no remaining app windows.

The first #208 CI failed a queue lease test after its fixed 20 ms wait. The fix now
lives in prerequisite PR #210 (`codex/queue-test-synchronization`): it waits for
dispatch with a two-second deadline and unchanged assertions. #200 is based on
that prerequisite, so its review diff remains visual-only. The fix is propagated
through #206, #207 and #208. No PR has been merged.

Native macOS verification and screenshot upload are complete, including the user's
title-bar confirmation. The macOS complete-stack root checks passed. Final CI
status is recorded in the PR descriptions; capture revisions above remain unchanged.

## Initial Windows follow-up — September 30, 2026

- Fetched and preserved the Mac changes; the prior Windows stack remains available
  at `codex/windows-pre-mac-sync`. Existing untracked workspace files were untouched.
- Bun 1.4.0 root typecheck passes on the synchronized stack.
- Targeted regressions: 35 pass, 1 POSIX-only cancellation-process test skipped,
  179 assertions. All 11 queue/lease tests pass on the isolated prerequisite too.
- Root Windows tests are **not green**: 31 failures (auth-client 3, agents 7,
  desktop 5, tools 4, KiCad 4, core 8). UI: 76 pass; client-core: 94 pass.
  The scripts phase does not run because the workspace test phase fails.
- A same-host baseline run on main plus the test-only prerequisite reproduced 30
  of those failures. Four mechanical tests failing in that baseline now pass with
  the Mac fixture fixes. The remaining tools MCP progress test also fails on a
  focused rerun (two progress notifications versus at most one expected); its test,
  mocks and production tools code are unchanged from main. Its cause is unresolved.
- Known Windows failures include path/permission assumptions, symlink EPERM,
  subprocess behavior and KiCad test support. They have not been hidden or marked
  as passing. The Git child-close cancellation regression is still POSIX-only.

## Windows failure fixes — September 30, 2026

Follow-up branch: `codex/windows-test-portability`, based on the complete stack at
`45aeced265a08d4ac1328a9b2398a8cded2a2c8b`. The initial failures above are historical;
this follow-up fixes them separately from the visual-refresh and workflow PRs.

- Fixed real Windows behavior: release inventory paths now use forward slashes so
  fabrication ZIPs include their outputs; KiCad PATH uses the platform delimiter;
  agent and KiCad environment overrides honor Windows' case-insensitive names.
- Platform-parameterized profile paths now use that platform's path rules. Native
  path expectations and mock filesystem paths work on Windows, macOS and Linux.
- Replaced POSIX shell test fixtures with the existing Bun runtime or the KiCad
  invocation tracer. The mechanical tests still run real KiCad exports and keep
  their geometry, cancellation, mutation detection and cache assertions.
- The user reported Smart App Control blocks while locally compiled fixture
  executables failed. Those fixtures were removed. No unsigned runners or changes to
  Windows security settings are required by this fix.
- Windows safety tests use directory junctions rather than privileged file
  symlinks; POSIX keeps file-symlink coverage. Permission-bit assertions run only
  where POSIX modes apply; credential and archive persistence still run everywhere.
- The MCP failure was a real configuration mismatch: durable routing retained
  request heartbeats. It now disables those heartbeats while preserving HTTP's
  existing queued-job response. The assertion now requires zero heartbeats.
- Fixed the additional intermittent `route.done` test race by awaiting the exact
  run's event, with a bounded deadline, before checking its payload.

Windows root `bun run typecheck` and `bun run test` pass with Bun 1.4.0, including
the scripts phase: **922 passed, 17 existing skips, 0 failures**. Existing
platform/optional skips remain; no new test was skipped
to obtain a passing result. These are automated checks, not a repeat of the native
macOS GUI walkthrough or new screenshot captures.
