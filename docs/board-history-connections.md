# Board history and connections

Two destinations in the project workspace menu, sharing one side-by-side board view
(`packages/ui/src/board/BoardPairView.tsx`). The interaction follows
[System Studio](https://github.com/TensorFleet/system-studio); the code is native to fabPlane.

## History

Pick a board, then a revision on the timeline. The older revision is on the left and the newer on
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

Click a part on each board, then **Link these parts**. Links live in `fabplane.connections.json`,
git-tracked at the project root. Selecting a linked part brings up the part it connects to.

Each link stores what its two parts looked like when it was made. It becomes **Needs review** only
when a linked part moves, rotates, changes side or footprint, or its pins or nets change. Edits to
other parts leave it alone. **Mark reviewed** accepts the parts as they are now.

History reports when a change touches a linked part, with a button to open that link.

Links are records of intent. **Unverified** is deliberate: nothing here checks electrical
compatibility, pin mapping, cable fit or mating. Shared net names and **Suggest from net names** are
hints from names alone.

Connections from the enclosure design and the assembly manifest are listed read-only. Cable length
and fit stay in Mechanical.

## Tools

In the `project` toolset, so they work at an assembly root and take an explicit `pcbPath`:
`board_list`, `board_view`, `board_revision_timeline`, `board_revision_compare`,
`board_revision_save`, `connection_list`, `connection_add`, `connection_remove`,
`connection_review`, `connection_suggest`.

## Limits

- No automatic history: a project with no git, saved points or export copies has only its current file.
- Restoring an old revision is not offered here.
- The two drawings zoom and pan separately.
- These screens exist in the canvas workspace, not the classic layout.
