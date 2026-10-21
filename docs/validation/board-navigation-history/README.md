# Board navigation and chat timing

- Compact board section menu with selected view, all nine shortcuts, keyboard navigation, and reduced-motion support. Wide panels retain tabs.
- Ordering's Back button uses 16px right padding while the board is open; a closed board reserves space for the workspace toggle.
- Thread snapshots include saved run history, including runs referenced by copied branch messages. Older replies show their own duration and failed/stopped status. Missing timestamps remain untimed; older daemons still support the latest-run fallback.

## Screenshots

Captured from actual Windows Electron components in the development app:

- `board-sections.png`: live board panel, compact menu open.
- `order-back.png`: actual OrderFlow component with sample vendor/readiness data; board-open state.
- `past-chat-durations.png`: actual MessageList component with two sample saved runs, demonstrating timing for both the earlier and latest reply.

## Verification

- 20 focused HTTP and chat-rendering tests passed, including repeated thread reads, copied branch history, per-run durations, and stopped runs.
- UI, client-core, and core typechecks passed.
- Desktop production build passed.
- Live menu checks: 320/700/800px panels, selection, arrow keys, Home/End, typeahead, Escape, Tab focus return, and resize to the wide tab strip.
- Live ordering checks: 16px right gap with board open; no Back/toggle overlap with board closed.
- Live chat check: all ten saved runs had complete timestamps and displayed durations.
