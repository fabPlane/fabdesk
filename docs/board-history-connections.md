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
| Saved point | `saved:<sha256>` | **Save this revision**, in `.fabdesk/board-history/` |
| Export bundle | `export:<path>` | Exact copies in `exports/*/boards` and `exports/*/source-boards` |
| Another PCB | `file:<path>` | **Compare any two** only |

Parts match by reference. A new reference with the same footprint `path` or `uuid` is a rename;
without a shared identity it stays a removal and an addition.

Footprints are drawn from their pads. Silkscreen, courtyards and schematics are not compared here;
the Review → Changes diff still covers schematics and copper in more detail.

## Connections

Click a part, then say where it connects: choose a board and a part in the panel, or click the part
on the other board. Then set which pin goes to which pin, using the lists or by clicking a pad on each
part. Matching net names fill in a starting map, which is only saved when you save it. Selecting never
zooms; **Zoom to** is a separate button. A part can connect to several parts.

Links live in `fabplane.connections.json`, git-tracked at the project root. Selecting a linked part
brings up the part it connects to.

Each link stores what its two parts looked like when it was made. It becomes **Needs review** only
when a linked part moves, rotates, changes side or footprint, its pins or nets change, or a mapped
pin no longer exists. Edits to
other parts leave it alone. **Mark reviewed** accepts the parts as they are now.

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
screens on a throwaway project with real input, then removes it.

## Limits

- No automatic history: a project with no git, saved points or export copies has only its current file.
- Restoring an old revision is not offered here.
- The two drawings zoom and pan separately.
- Lines appear only between the two boards on screen.
- These screens exist in the canvas workspace, not the classic layout.
