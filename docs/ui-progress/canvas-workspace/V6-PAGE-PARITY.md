# v6 page-by-page visual review

Reopened by the user's October 29 comparison: the shared style pass was insufficient. This pass checks composition, content scale, navigation and requested tools against every scene in `outputs/fabplane-workspace-v6/design-spec.json`. The implementation uses actual saved sources and reports; illustrative concept boards, revisions and counts are not acceptance fixtures.

## Current work

| Reference | Actual page / state | Review and action |
| --- | --- | --- |
| 00 Fresh start | Blank project, central composer | Prior capture531: single composer and alternative sketch/import inputs. Recheck after shared changes. |
| 01 Sketch reference | Saved project reference and requested assistant | Review requested conversation width and available sketch space. Preserve editable-copy and unsent-draft behavior. |
| 02 Project overview | VAIO six-board map | Enlarged cards270×200, larger text, reduced Fit padding, visible Connections/3D choice, green Overview. Capture533. Saved positions unchanged. Actual PCB aspect ratios and previews retained. |
| 03 Board selection | Selected native PCB location / part | Increased fitted drawing area. Recheck actual native selection and compact actions; no default inspector. |
| 04 Board resize | Requested native outline tool | Right320px dock reserves drawing space. Width/height, fixed native top-left anchor, outline-only scope, preview status and Apply/Discard grouped. Input formatting removes floating subtraction noise at native precision. Actual32mm proposal discarded; capture535. |
| 05 Review updates | Design sources, generated outputs, saved checks | Recheck the three separate groups and readable actions. Keep explicit reconciliation limitations. |
| 06 Changes/comments | Saved native comparison and requested discussion | Review full-canvas comparison and disclosure. Do not fabricate general history, pinned geometry or publication. |
| 07 Checks | Root and assembly saved reports | Findings details moved from inline/bottom expansion to one requested right inspector. Source context condensed; scope picker in task row, run action beside heading. Captures536wide and539compact. Inspector aligns beside source context and findings, stays above the assistant. Close returns focus; search/no-match/clear verified. No checks run. |
| 08 Outputs | Saved library / selection | Recheck three-column gallery, filenames, source/search, stable selection actions. Use actual media. |
| 09 Parts | Existing design BOM / hardware / shopping | Recheck readable table and task actions. Member aggregation, build quantity and stock remain unsupported where the existing implementation lacks them. |
| 10 Routing | Saved run / requested setup | Review board-first composition, requested settings and playback. Preserve actual failed-run state; do not reroute for a screenshot. |
| 11 Mechanical entry | Existing teammate-owned feature | Reference reviewed; shared chrome only. Internals excluded from this pass. |
| 12 Mechanical import | Existing teammate-owned feature | Reference reviewed; shared chrome only. Internals excluded from this pass. |
| 13 Artwork | Existing persistence / preview | Reference reviewed; preserve structure. Further polish and Apply integration remain user-deferred. |
| 14 Files/Notes | File explorer, preview and notes | Review comfortable explorer/preview proportions, contextual file actions and text readability. No spatial zoom on lists. |

## Verification in progress

- Geometry tests:23pass/132assertions/0fail (scene membership, local positions and ports, native outline guards and input precision).
- Native resize walkthrough: saved36.8×27.4, proposed32×27.4, explicit not-applied status, Discard returns saved dimensions and disables Apply, Escape closes and returns focus to Board size.
- UI and client types PASS; UI234tests/917assertions/0fail. All8current VAIO native/manifest paths match the pre-walkthrough baseline. Remaining pages and the final route audit are still in progress.
- All publication remains local. Original concepts and previous captures are preserved. No engineering capability is declared complete by visual similarity.
