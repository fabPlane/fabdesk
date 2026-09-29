# FabPlane desktop GUI review

## Latest review

**[Main versus current GUI](current/README.md)** — fresh screenshots of current implementation `ecfad8314853280c1067342f5a3d92b3f80f0607` compared with original main. These supersede the earlier comparisons below.

**[Responsiveness and cross-platform audit](responsive-audit/README.md)** — `95be0f4adf38e939b691e6ff321d6a5dd85fc10e`. Screen-by-screen coverage, fixes, screenshots, and explicit native macOS/Windows verification limits.

**[Workspace redesign, research, and new comparisons](iteration-2/README.md)** — implementation `8b0f68dc0f5077f856657819375b7ac086d08b8a`. Includes original-main comparisons, the previous GUI iteration, four themes, minimum-window captures, and a labeled conversation fixture. The evidence below records the earlier pass.

**Base:** `main` at `33d68bc109150789c45f7ad334c079931e39d353`

**GUI implementation:** `gui-improvements` at `8092e511ced9455bba51b893c42065e6e372db68`

**Responsive icon and composer refinement:** `38a59b561994a1f7ec4d7b58bac3eb6bc7cada7c`

**Empty-state icon cleanup:** `2f1f2d187eb1eaa39eb108a0d57edcc95ce91cbd`

All pairs use the same local FabPlane Dev profile, projects, dark FabPlane theme, display scaling, and selected state. The full-size captures are 1440 × 920. The narrow board pair is the app minimum, 960 × 600. The selected project is `PICOMEMCARD-REF`, with its empty Schematic view. The Claude installation warning reflects this machine's unchanged local setup.

## New chat · 1440 × 920

| `main` | `gui-improvements` |
| --- | --- |
| ![New chat before](before/new-chat-1440.png) | ![New chat after](after/new-chat-1440.png) |

The workspace and project list have more readable sizing and clearer selection. The board illustration now sits directly on the page, without an enclosing tile. The chat has a quieter, stronger composer. The top bar uses 20 px icons in 36 px targets, with separate controls and restrained status chips. The missing-agent notice keeps the issue visible while its full setup instructions open on demand.

## Selected project and board · 1440 × 920

| `main` | `gui-improvements` |
| --- | --- |
| ![Selected project before](before/project-board-1440.png) | ![Selected project after](after/project-board-1440.png) |

The selected project is easier to locate. Board tabs, empty-state text, and the render action have clearer spacing and hierarchy. The three-pane workflow and board action remain the same.

## Narrow board pane · 960 × 600

| `main` | `gui-improvements` |
| --- | --- |
| ![Narrow board before](before/board-960.png) | ![Narrow board after](after/board-960.png) |

The old tab strip hid later views behind horizontal scrolling. The labeled **View** menu now exposes all eight board views and shows the active one, including each shortcut. Project names truncate cleanly, the connection badge becomes a status dot with a detailed tooltip, and the compact setup notice leaves room for the composer.

## Settings · 1440 × 920

| `main` | `gui-improvements` |
| --- | --- |
| ![Settings before](before/settings-1440.png) | ![Settings after](after/settings-1440.png) |

The dialog uses the same surfaces, type, row spacing, and selected-state treatment as the shell. Theme choice and settings navigation stay in their existing places.

## Design references

- [Linear design refresh](https://linear.app/now/behind-the-latest-design-refresh): quieter navigation chrome, deliberate spacing, and surface hierarchy.
- [Figma UI3 redesign](https://www.figma.com/blog/behind-our-redesign-ui3/): protect canvas area while preserving familiar resizable controls.
- [Codex app](https://openai.com/index/introducing-the-codex-app/): project-organized agent workspace and clear conversation hierarchy.
- [Official OpenAI documentation on projects and chats](https://learn.chatgpt.com/docs/projects): quick navigation and shortcuts around project work.
- [OpenAI's Codex workflow guide](https://developers.openai.com/blog/mastering-codex-remote-for-engineering): keep workspace decisions legible and expose secondary detail when needed.
- [Cursor 3](https://cursor.com/blog/cursor-3): keep agent activity central and detail available on demand.
- [Raycast refresh](https://www.raycast.com/blog/a-fresh-look-and-feel): consistent icon treatment and visible shortcuts.

These informed the FabPlane-specific implementation; no third-party visual assets were copied.

## Chat and project workflow additions

The feature pass keeps the same shell and project workflow while adding message and project affordances. These captures were taken from the running `gui-improvements` desktop profile at the same minimum and desktop sizes.

| Flow | Capture |
| --- | --- |
| Conversation with visible local timestamps and date divider, 1440×920 | ![Conversation](chat-workflows/conversation-1440.png) |
| Conversation at the 960×600 minimum | ![Conversation minimum](chat-workflows/conversation-960.png) |
| Sidebar keyword search grouped by chat, 1440×920 | ![Search](chat-workflows/search-1440.png) |
| Sidebar keyword search at the minimum, 960×600 | ![Search minimum](chat-workflows/search-960.png) |
| Command palette search with title and message matches | ![Palette search](chat-workflows/palette-search-960.png) |
| GitHub import with parsed repository and exact destination, 1440×920 | ![GitHub import](chat-workflows/import-1440.png) |
| GitHub import at the minimum, 960×600 | ![GitHub import minimum](chat-workflows/import-960.png) |
| Imported repository with no KiCad board | ![No board](chat-workflows/import-no-board-960.png) |
| No-board project state in the board pane | ![No board pane](chat-workflows/no-board-960.png) |

The screenshots show the new behavior alongside the existing GUI comparison above. Search results open the chat and briefly highlight the selected message. Imports retain their Git origin, prevent destination collisions, allow cancellation, and give a clear no-board state.

## Verification

- Root `bun run typecheck`: passed.
- UI package tests: 71 passed.
- Script tests: 69 passed, 2 skipped.
- Root `bun run test`: reaches 264 passing core tests, then exits on 8 core failures. These tests are outside the changed UI package; at least the packaged KiCad cases assert POSIX paths (`/project`, `/work/board`) but receive Windows paths (`C:\\project`, `C:\\work\\board`). The root command therefore does not reach the script tests; those were run directly.
- Manually checked all four themes at 960 × 600, project selection, new chat, Settings, visible keyboard focus, command palette (`Ctrl+K`), all eight board views (`Ctrl+1`–`Ctrl+8`), the narrow View menu, and title-bar controls at both capture sizes. No control was clipped or stranded in the reviewed states.
