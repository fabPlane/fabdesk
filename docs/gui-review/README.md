# GUI review

PR #200 contains the desktop visual refresh only. Chat search and timestamps,
project locations and GitHub import, and composer queueing are reviewed in
separate stacked PRs.

## Review corrections

- Expanding a project only toggles its chat list. Opening a chat or creating a
  new chat selects that project explicitly.
- Icon buttons have explicit 24, 28 and 36 px sizes. Inventory and shopping
  rows use 24 px controls; shopping add-row fields share a 32 px height.
- Ordering keeps the board pane visible.
- Long chat titles truncate within the sidebar grid at the minimum window size.
- Window-size minimum calculations are throttled to at most ten updates per second.
- Focus-trap filtering and tab-key wrapping have focused regression tests.

## Visual evidence

The original main baseline is `33d68bc109150789c45f7ad334c079931e39d353`.
The earlier visual comparison was captured at `ecfad8314853280c1067342f5a3d92b3f80f0607`
and stored in historical commit `6e10a82688b93a81b78c565df00ff8c3bb21f841`.
Its paired images remain embedded directly in the PR description, labeled with
their capture revision. They are historical evidence, not screenshots of these
review corrections.

Screenshot binaries and superseded iteration reports have been removed from the
branch's final diff. GitHub-hosted PR attachment upload remains pending; historical
commit image URLs keep the existing comparison visible meanwhile.

## Design references

- [Linear](https://linear.app/now/behind-the-latest-design-refresh): quieter chrome and alignment.
- [Figma UI3](https://www.figma.com/blog/behind-our-redesign-ui3/): protect canvas space.
- [Codex](https://openai.com/index/introducing-the-codex-app/): project-organized workspace.
- [Cursor](https://cursor.com/blog/cursor-3): clear agent work and secondary details.
- [Raycast](https://www.raycast.com/blog/a-fresh-look-and-feel): icons and shortcut discovery.

## Verification

The complete implementation passed root `bun run typecheck` before the split.
The visual-only split also passes root typecheck and all 76 UI tests.
Electron checks at 960×600 confirmed expansion preserves the active chat and
ordering keeps the board visible without page overflow.
Remote-listener regressions: 15 passing tests, including all three custom-path
entry points and local/default-directory compatibility.
Pure keyboard, shared URL parser, bracket-preserving search, import and custom
project-location tests pass. The broader project test file encounters Windows
`EPERM` when creating a symlink.

Root `bun run test` remains failing in several workspaces on this Windows host.
Failures include POSIX path and permission expectations, executable/process
assumptions, and installed KiCad format compatibility. These are reported rather
than treated as a passing verification gate. Native macOS has not been tested.
