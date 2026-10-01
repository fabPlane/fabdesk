# Inspecting and repairing a schematic

Use `schematic_inspect` and `schematic_edit` for native schematic work. Inspection defaults to a saved-file hierarchy summary. `detail: "full"` requests native objects; providing any selector also requests objects even with the default summary detail.

`references`, `netNames` and `objectIds` compose as a union. References select the symbol and its pins; IDs select exact objects. Net names select the corresponding electrical objects on the selected sheet. `expand: "nets"` adds complete electrical nets touched by a selected reference or object. It includes other symbols only as containers of selected pins; it does not expand through their other pins. `kinds` filters after selection/expansion. Electrical expansion uses KiCad's reported net item IDs and pin membership. Geometric contact and matching label text do not infer membership. `limit` bounds native objects, including pin containers and pins, in stable inspection order; net metadata has a separate bound of the same size. The response reports matched/returned counts and truncation. Raise the limit if a repair needs omitted objects. Untargeted full and authoring inspection have no default object limit; targeted calls default to 1,000. An explicit limit can be set up to 10,000. The top-level `counts` and introductory text always describe the entire selected sheet; `selection.counts` describes the requested/returned objects. Compact authoring omits wire arrays but still reports the true wire/label/junction counts.

Positions are absolute sheet coordinates in millimetres: the origin is the upper left of the sheet, X grows right, Y grows down, and the schematic grid is 1.27 mm. Pin positions include symbol rotation and mirroring. Do not transform them again. `revision` is live IPC revision; `hierarchy.aggregateRevision` binds independently exported saved-file hierarchy evidence. Session diagnostics are informational and do not replace saved-file ERC. Net names/counts describe project nets; returned item IDs are projected onto returned sheet objects.

For hierarchy, use `scope.identity` (`uuid:path`) from inspection as the edit's `sheet`. Unambiguous human paths, sheet names and native filenames also work. Ambiguous selectors fail rather than selecting a different instance of a repeated sheet.

For example, inspect a timer's control net:

```json
{"netNames":["/CONTROL"],"kinds":["symbols","pins","wires","labels","junctions"],"limit":200}
```

For a local wire replacement, copy an inspected wire's `id` into `deleteItemIds`, and its `start` and `end` into `wires`. Labels reuse `{text, position}`. Junctions and no-connects reuse their **position**, as `{x, y}`, rather than the whole inspected object. A schema-valid example is:

```json
{
  "wires": [{"start":{"x":50.8,"y":50.8},"end":{"x":55.88,"y":50.8}}],
  "junctions": [{"x":55.88,"y":50.8}]
}
```

Set `sheet` to the inspected identity and delete only the IDs being replaced. Editing uses one undoable commit even when symbols are rotated/mirrored. Unknown deletion IDs and conflicting update/deletion requests are rejected before committing. New or renamed references are checked against every sheet in the project. Power symbol normalization targets the edited native sheet. Off-grid arguments are preserved and reported with their argument paths and coordinates in `gridProblems`.

After saving, KiCad may merge collinear wires or remove redundant junctions. `changedObjectIds` describes the resulting native document, and `normalizedAwayObjectIds` identifies requested creations removed by that normalization. Created counts describe retained objects. Untouched symbol reload metadata does not mark those symbols as updated; explicit symbol updates remain reported. Inspect the returned IDs to obtain final geometry, then run `verify_erc` when electrical verification is needed. Unrelated objects are not rebuilt.
