# Schematic entry flow — user feedback follow-up

This revises the shared structure after the confusing empty Schematic screenshot. Local only; no remote publication.

- Board selection and PCB / Schematic / 3D tasks now share one toolbar row. All boards is inside the named board menu. The header no longer repeats the selected board name.
- Opening a declared board with a native schematic automatically creates its missing preview through the existing source-bound inspection/render pipeline. A rendering failure has an explicit retry and error; stale saved previews remain labeled and require Update. No circuit source is rewritten to display it.
- When no linked schematic exists, show Find with agent, Import schematic, Generate with agent. Import opens the KiCad file picker and stages selected files with a source-bound request; Find searches the project/repository through a prepared agent request. Generate asks for a proposed circuit, preserving the existing PCB and requiring revision/dependency/connectivity review. These requests require Send; this change does not claim a successful agent import or generation.
- Source identity and manifest revision live in a collapsed board-context disclosure, accompany the submitted request, survive reload, and remain removable. Multiple requested boards retain their captured contexts. Existing prose and earlier conversation drafts are preserved.
- A prepared new board request uses a compact corner assistant without the generic sketch-start hero. Assembly projects no longer offer the single-board Finish it automation or show its unrelated stopped netlist checklist; active sessions retain Stop controls.

## Verification

UI typecheck passed. 234 UI tests / 917 assertions / 0 failures, including persisted board contexts separate from prose and other drafts. Native walkthrough: LCD missing schematic entry; KiCad import picker/cancel; concise unsent Generate request; I/O automatic source-bound preview displayed. Eight current native/manifest paths were captured before this walkthrough: all unchanged. Only generated preview artifacts were created. See schematic-flow-native.json and screenshots 515, 516, 518.

Automatic discovery remains limited to the existing declared/canonical board source contract. Schematics with different names or elsewhere in a repository need the Find/import path; no unrelated source is silently paired. Native source/preview matching is not proof of PCB parity, ERC, or assembly compatibility. Agent import/generation and model-provider behavior were not executed in this check. Mechanical stays teammate-owned; Board Art polish stays deferred.
