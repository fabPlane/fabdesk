# Board history and connections

Two destinations in the project workspace menu, sharing one side-by-side board view
(`packages/ui/src/board/BoardPairView.tsx`). The interaction follows
[System Studio](https://github.com/TensorFleet/system-studio); the code is native to fabPlane.

## History

Pick a board, then a revision on the timeline. Step back and forth with the arrows or the Left and Right arrow keys; a selected part and the camera stay put, so one part can be followed through its history. The older revision is on the left and the newer on
the right, in one frame at one scale. Removed parts appear only on the left, added parts only on the
right, and moved or changed parts on both. Coordinates are measured from the board outline corner,
so moving a board on the KiCad sheet is not a change.

A revision is one distinct board content, from any of:

| Source | Ref | Notes |
| --- | --- | --- |
| Current file | `worktree` | Always the newest entry |
| Git commit | commit hash | Only commits that touch this PCB |
| Saved point | `saved:<id>` | **Save this revision**, in `.fabdesk/board-history/` |
| Export bundle | `export:<path>` | Exact copies in `exports/*/boards` and `exports/*/source-boards` |
| Another PCB | `file:<path>` | **Choose revisions** only |

Saved-point IDs include the board path and content hash, so identical files on different boards keep independent histories. Older content-only IDs still resolve. Malformed or tampered saved points are excluded from the timeline. Concurrent saves of the same revision retain the first committed label. A truncated timeline explicitly says older history is omitted; a partial or invalid PCB produces a recoverable error rather than an empty comparison.

Parts match by reference. A new reference with the same footprint `path` or `uuid` is a rename;
without a shared identity it stays a removal and an addition.

Footprints are drawn from their pads. Silkscreen, courtyards and schematics are not compared here;
the Review → Changes diff still covers schematics and copper in more detail.

## Connections

Click a part, then say where it connects: choose a board and a part in the panel, or click the part
on the other board. Then set which pin goes to which pin, using the lists or by clicking a pad on each
part. Matching net names fill in a starting map for a new connection, which is only saved when you save it. An existing empty map stays empty. Connection editing is briefly locked while a write completes, so its response cannot clear newer edits. Selecting never
zooms; **Zoom to** is a separate button. A part can connect to several parts.

Links live in `fabplane.connections.json`, git-tracked at the project root. Selecting a linked part
brings up the part it connects to. **Saved connections**, **Other connections**, and **Colour guide** expand on request, keeping the two boards and current pin map central. The pin editor scrolls independently in small windows. Escape closes the editor and returns keyboard focus to the board. Saved connections remain removable when a linked part or board has been deleted. Boards with duplicate names include their relative paths in pickers.

Each link stores what its two parts looked like when it was made. It becomes **Needs review** only
when a linked part moves, rotates, changes side or footprint, its pad geometry, pins or nets change, or a mapped
pin no longer exists. Edits to
other parts leave it alone. Older links without a pad-geometry baseline require one review to capture it. **Mark reviewed** accepts the parts as they are now.

History reports when a change touches a linked part, with a button to open that link.

Parts are colour coded on both boards, and each screen has a legend. Fill shows new, changed or
existing against the board's previous revision. A dashed outline marks a connector, a purple outline a
likely match once a part is selected, and teal, amber or red outlines a part that is connected, needs
review or has lost its partner. Lines join related parts across the two boards, and pins once a pair is
open, with a chip naming a partner on a board not currently shown. Hovering says what a click would do.
`board_view` and `connection_list` report the same status to agents.

Net names are compared without their sheet prefix, so `/Sensors/SDA` on one board meets `SDA` on another, in suggestions, likely matches and the pin check alike. The pin check compares net names across each stated pin. It flags different power or ground nets as a
conflict and different signal names for review. Names can agree on a wrong connection and differ on a
right one, so links stay **Unverified**: nothing here checks the circuit, cable fit or mating.

Connections from the enclosure design and the assembly manifest are listed read-only. Cable length
and fit stay in Mechanical.

## Tools

In the `project` toolset, so they work at an assembly root and take an explicit `pcbPath`:
`board_list`, `board_view`, `board_revision_timeline`, `board_revision_compare`,
`board_revision_save`, `connection_list`, `connection_add`, `connection_remove`,
`connection_review`, `connection_set_pins`, `connection_suggest`.

## Checking the screens

With `bun run dev` running and its window visible, `bun run check:board-workspace` clicks through both
screens on a throwaway project with real input, then removes it. It also checks intentionally empty pin maps, keyboard focus return, workspace navigation with the saved list open, renderer restart persistence, missing endpoints, and recovery after a corrupt PCB is repaired. Set `FABDESK_USER_DATA` to an isolated profile and optionally `FABDESK_BOARD_CHECK_SCREENSHOTS` to an evidence directory outside the checkout to capture History and Connections.

Optional check modes (combine them for the release matrix):

- `FABDESK_BOARD_CHECK_THEME=fabplane-dark|fabplane-light|plain-dark|plain-light`
  switches the isolated profile through the real Appearance controls.
- `FABDESK_BOARD_CHECK_LONG_LABELS=1` uses duplicate board names, long paths,
  long values and net labels, and checks horizontal overflow.
- `FABDESK_BOARD_CHECK_WRITE_FAILURE=1` makes the disposable project directory
  read-only temporarily, verifies that a failed save retains its draft and prior
  file, then restores permissions and retries. Use on a non-root POSIX host.

## Local macOS review — November 10, 2026

Reviewed PR #423 at `d47f725dcc6c6bc449205a039f3076e5c1c42367` with the local,
uncommitted History/Connections fixes. Existing Composer edits were preserved.
The tests and captures below describe that working tree, not the unchanged remote
PR head. The evidence manifest records source hashes for the tested files.

- Bun 1.4.4 (within the required 1.4.x range): root `bun run typecheck` passed;
  root `bun run test` passed with 3,000 passes, zero failures and 36 existing skips.
  No assertions were weakened and no skips were added.
- `bun run build:desktop` passed with installed Node 24.18.0 on PATH. The initial
  build using the shell's older Node failed because Vite required `crypto.hash`.
  No `.map` files were found in the desktop build output.
- The fresh Electron app used an isolated development profile and disposable
  boards, with no agent runs. All 42 native checks passed in each of the four
  themes at both 1440×920 and 960×600 (336 assertions across eight final runs).
  This includes real click/keyboard input, long labels and duplicate board names,
  failed-save draft retention and retry, empty pin maps, save/review/removal,
  renderer restart, missing endpoints, corrupt-file recovery, and navigation.
  Sixteen matrix screenshots plus three real-board captures are retained with
  the logs and source-hash manifest under
  `astra-handoff/pr423-review-2026-11-10/release-check/` outside the repository.
- A tool-level load check with 500 parts per board and 12 saved revisions took
  189 ms for the timeline, 23 ms for a drawing and 147 ms for suggestions on this
  Mac. A real KiCad fixture (USB timer, 12 parts) parsed and drew successfully.
  These are local tool timings, not a renderer frame-rate guarantee.
- A full app-and-daemon restart retained a saved revision, project and saved
  connection from the real USB timer fixture; the connection file's bytes were
  unchanged. The restored History and Connections screens rendered successfully.
  Repeated physical pads sharing one pin number render with distinct React keys;
  zooming the real connector showed eight labels with no console errors.
- Native mouse resizing and compact pin-panel scrolling were checked at 960×600.
  Both board previews remained visible, and the lower pin controls and Remove
  action were reachable.
- Screenshot binaries and raw logs remain outside the repository.
- Windows/Linux native checks, signed installer/update behavior and unrelated
  app flows are outside this pass. Remote CI at the unchanged head is green but
  does not validate these uncommitted fixes.

## Merge-readiness check — November 11, 2026

An isolated combined-source checkout tested PR head
`1c680dd6875c40ba180dbaea84a1bfb9d46fe8bf` against current `main`
`2a6d32b19dde758b16eb5a7e54d45802c6d1ffec`, without merging either branch.
The merge was conflict-free, but the compact-toolbar selector hid **Fit sheet**
after main grouped the zoom controls. Native checks reproduced this on both
History and Connections at 960×600. The selector now hides only the final direct
button (Fit width), and the native script checks Fit sheet visibility on both
boards and its ability to reset a zoomed drawing.

With that fix, root typecheck and desktop build passed. Root tests passed with
3,056 passes, zero failures and 38 skips. No assertions were weakened and no skips
were added by this fix.
The initial archive-only test attempt failed its Git checkout identity check;
creating Git metadata in the isolated verification copy resolved that setup issue.
All 45 native checks passed at 960×600 (fabPlane dark) and 1440×920 (fabPlane light),
including long labels, failed writes, restart persistence and recovery cases.
This supplements the earlier four-theme matrix. Fresh before/after captures and
logs are outside the repository in `astra-handoff/pr423-merge-review-2026-11-11/`.

## Limits

- The pin editor supports one target per source pin. A saved map with multiple targets for a source is shown in full but cannot be overwritten from that direction; select the other end when that direction has a single target per pin. Many-to-many maps remain read-only in this editor.

- No automatic history: a project with no git, saved points or export copies has only its current file.
- Restoring an old revision is not offered here.
- The two drawings zoom and pan separately.
- Lines appear only between the two boards on screen.
- These screens exist in the canvas workspace, not the classic layout.
