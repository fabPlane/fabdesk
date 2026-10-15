# Native checkpoint recovery

`project_checkpoint` retains named saved native files, lists checkpoints, compares the saved
working project with a retained baseline, and restores an explicitly chosen checkpoint. It is
advisory: retaining or restoring does not run design checks or accept the task.

To restore, compare first, then supply `action: "restore"`, `checkpointId`, the comparison's
`currentRevision` as `expectedRevision`, and a reason. Restore validates every captured file and
preserves the displaced saved native files as a separate checkpoint. The original task baseline
and scope remain unchanged. The response identifies both retained versions and the restore journal.

The shared session boundary refuses unsaved or unmeasurable live schematic/PCB state and active
native operations. It stops the saved headless session before replacement; subsequent inspection
opens the restored state. Previously acquired handles cannot save afterward. Native transaction
rollback uses the same boundary. Conflict refusals bypass destructive outer transaction rollback.
Schematic inspection leaves saved library tables intact; editing/construction may explicitly
register the current bundled libraries, and comparison exposes the resulting saved-file changes.

Replacement is staged and revision checked but cannot atomically exclude arbitrary external
writers or make a multi-file filesystem replacement crash-atomic. A partial restore reports the
completed paths and preserved checkpoints in `.fabdesk/task-checkpoints/restores/`. Deliberate
recovery uses a fresh comparison; automatic rollback never overwrites a racing writer. A process
crash can leave `capture.lock`; inspect the journal and retained files before removing that lock.

Capture includes saved native PCB/schematic/project/rules/library-table files beneath the project,
including child native files, excluding runtime/output directories. It does not capture every
authoring script, compiler source, local symbol/footprint library, model or external dependency.
It is a saved native file set, not a promise of a fully reproducible project.

Comparison measures PCB tracks/arcs/vias, footprint placement/properties/attributes and pad
net/geometry. Schematic connectivity and zone/fill semantics remain unmeasured, with changed saved
file hashes visible. Compare runs no native verification; check the restored revision independently
before treating any retained artifact as complete or releasable. Unsaved GUI sessions outside this
owned headless session and raw bridge writers remain separate qualification boundaries.
