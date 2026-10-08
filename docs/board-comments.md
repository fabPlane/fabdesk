# Board comments

HeyPCB's Comment (shipped 2026-09-29) pins a question to a spot on the board and has Inky answer it from the design, plus a shared notes sheet. fabPlane's first version does the same with git-native files and the existing agent adapters / MCP tools.

## Files

| Path | Role |
| --- | --- |
| `comments.json` | Structured pins (`fabplane.board-comments` 1.0.0) |
| `NOTES.md` | Shared notes sheet |

The JSON contract matches `@pcb/shared` on TensorFleet/fabplane.com. Do not put pin text in SQLite.

## MCP tools (`project` toolset)

`load_toolset {"toolset":"project"}` then:

- `comment_list` / `comment_pin` / `comment_answer` / `comment_resolve`
- `notes_read` / `notes_write`

When the desktop asks the agent about a pin, the composer is filled with `buildCommentAskPrompt`. The agent should inspect (`pcb_inspect` / `schematic_inspect`) and call `comment_answer`.

## HTTP

- `GET/POST /projects/:id/comments`
- `PATCH /projects/:id/comments/:commentId`
- `GET/PUT /projects/:id/notes`

## Desktop

Comment mode on the schematic and PCB SVG tabs drops a numbered pin. The Notes board tab edits `NOTES.md`.

## Left out of v1

- Automatic object picking under the click (ref/net are typed, coordinates are SVG viewBox)
- Pins on the 3D / product views (schema accepts them)
- MCP Apps `board_viewer` pin overlay
- Starting an agent run without a thread (no open chat → prompt is drafted in the composer)
