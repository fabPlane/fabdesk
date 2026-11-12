# Custom checks (data)

Drop a JSON file in `.fabdesk/board/review/checks.d/` to add a check for the project (or the boards it lists); no code edits.
The command prints a JSON list of findings and the review treats them like any built-in check (proposals, dispositions, gate).
The commands are shell commands from the project's own files, so `board_review run` executes them only with `trustCustom`.

```json
{"name": "my-check", "layer": "L3", "boards": ["my-board"],
 "run": "python3 checks/my_check.py {pcb} {netlist}", "timeout": 300}
```
Placeholders: `{pcb} {sch} {project} {netlist} {spec} {out}`. Each finding:
`{"rule": "X", "severity": "must-fix|question|note", "claim": "...", "ref": "U1", "pad": "3", "net": "...", "key": "...", "suggest": "..."}`.
A check that fails or prints anything but a JSON list is an error, never a pass.
