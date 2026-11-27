# Laser cell: ElRobot arm + ComMarker Omni X

Status 2026-11-26: implemented and tested against simulated servos and a simulated laser. **Not yet run on
real hardware** (no Omni X, servo board, USB relay, ComMarker Studio or LightBurn on the development machine).

The laser cell turns a fabPlane board into copper on a blank, hands-free:

1. **Copper job** — `export_laser_copper` turns the board's copper layer into a copper-removal job
   (`exports/laser/<side>-Cu-laser-<mode>.lbrn2|svg|json`).
2. **Arm** — an [ElRobot](https://github.com/norma-core/norma-core/tree/main/hardware/elrobot) follower arm
   (Feetech ST3215 servos on a USB bus-servo board) picks a copper-clad blank from a stack, places it in a
   corner jig on the laser bed, and moves out of the laser's way.
3. **Laser** — fabPlane starts the job, waits until it has finished, then the arm moves the board to an
   output tray. Repeat for N boards; the batch ends early when the stack is empty.

UI: **Laser cell** in the project workspace menu (`packages/ui/src/board/LaserCellWorkspace.tsx`).
Agent: `load_toolset laser` → `export_laser_copper`, `laser_cell`.

## One-day plan (fastest path to a working cell)

Start the build with **`Desktop\fabPlane Laser Cell (dev).cmd`** (runs as "fabPlane Dev" next to the installed app), open a project,
workspace menu → **Laser cell**.

0. **No relay? Use Studio window control (default).** Install ComMarker Studio (portable zip from
   commarker.com/download-center, unzipped to `%LOCALAPPDATA%ProgramsComMarker_Studio`) and start it with the
   **`ComMarker Studio (fabPlane)`** desktop shortcut: it runs Studio *without* administrator rights (`__COMPAT_LAYER=RunAsInvoker`),
   which fabPlane needs to press Studio's buttons. Connect the Omni X in Studio, open the job, leave Studio on that page.
   Laser cell → 2 · Laser: "ComMarker Studio (fabPlane presses Start in Studio)". Then go to step 3. If Studio cannot
   find the laser without admin rights, run `CypressDriverInstaller.exe` from Studio's folder once (approve the prompt yourself).
1. **Relay (30 min).** Either a CH340 "LCUS-1" USB relay, or an Arduino/ESP32 + 1-channel relay module running
   [laser-cell-footswitch.ino](laser-cell-footswitch.ino). Wire the relay's COM + NO across the two foot-switch wires
   (dry contact, in parallel with the pedal). Laser cell → 2 · Laser: ComMarker Studio, relay type, port, Save.
2. **Prove the trigger (15 min).** Load any small job in ComMarker Studio with foot-switch start enabled (machine
   setting "Marking input port" = IN2). Lid closed. Press **Press once**: Studio must run the job exactly once.
3. **Copper settings (1–2 h).** 1 · Copper job → Make laser job. Import the SVG into Studio, enter the table
   values below, run Studio's material test on scrap of the same blank, meter the isolation, adjust passes.
   Enter the measured job time in **Job time (s)**.
4. **Laser-only runs.** Place boards by hand against the jig, Mode **Laser only**, Start. This is the fallback if
   the arm is not ready.
5. **Arm (if assembled).** Connect arm → Relax → teach the stations → Hold → **Dry run** (laser never fires) until
   it is clean → confirm the UV guard → **Full cycle**.

Manual foot-switch control: **Press once** (250 ms, one job), **Hold down** / **Release** (the Arduino sketch also
releases by itself after 10 s). A held pedal shows the laser as busy, so a run cannot start until it is released.

## How fabPlane controls the laser

ComMarker publishes no API, command line, scripting or remote start for **ComMarker Studio** (checked
2026-11-26), so there are two routes:

| Route | Start | Knows when it is done | Stop from fabPlane | Needs |
| --- | --- | --- | --- | --- |
| `studio-window` (default) | Presses Studio's own **Start(F2)** button through Windows UI Automation (no mouse/keyboard) | Yes, inferred: the Start button changes/greys out while marking and returns after; or `studioCompletion: timer` | Presses Studio's Stop if it shows one (E-stop still required) | Windows, Studio started without admin rights, PC unlocked during a run |
| `studio-footswitch` | Closes a USB relay wired in parallel with the Omni X **foot switch**; Studio runs the job it has loaded | No: waits the job time you enter (Studio's estimate, then the timed first board) + a margin | No (E-stop) | LCUS-type CH340 USB relay (≈ $5, `A0 01 01 A2` on / `A0 01 00 A1` off at 9600 baud), Studio's foot-switch start enabled |
| `lightburn` | UDP `FORCELOAD:<job>` then `START` on port 19840 | Yes: polls `STATUS` (`!` busy, `OK` idle) and needs to see busy → idle | No (LightBurn has no UDP stop) | LightBurn with the galvo licence, UDP automation enabled, Omni X set up as a galvo device |
| `simulator` | — | — | — | nothing; for dry runs and tests |

The LightBurn route is the more reliable one for unattended runs because completion is observed, not
timed. Users have reported LightBurn's Start only framing on an Omni X; the driver treats "never saw busy
within 8 s" as an error rather than a finished board.

Drivers: `packages/laser-cell/src/lasers.ts`, `packages/laser-cell/src/studio-window.ts`.

**Studio window control** (checked on Studio 1.0.41, 2026-11-27, without a laser attached): Studio is a Qt app and
exposes its widgets to UI Automation by Qt object name (`...MarkMgrDlgLBS.widget_CmdButtonList.btnMark.pbtnMain` =
"Start(F2)", `...DeviceStatusBg2.label_StateText` = connection state, `...checkBox_DoorSensor` = lid interlock).
Pressing Start through UI Automation works (on an empty document Studio answered "Please add at least one element").
fabPlane refuses to start while Studio shows "Disconnected" or any dialog, and stops the cycle if a dialog appears
while marking. **Not yet verified:** what the Start button shows while a real job runs; if fabPlane reports
"Studio's Start button never changed", set *Job finished when* to *Job time has passed*. Windows blocks a normal
app from pressing buttons in an administrator window, so Studio must not run as administrator.

### Wiring the foot-switch relay

Unplug the foot switch from the Omni X, measure which two contacts it shorts, and connect the relay's
**COM** and **NO** contacts to the same two pins (in parallel with the switch if you keep it). Use the
relay's dry contact only; never feed voltage into the laser's input. Confirm with the relay alone that one
pulse starts exactly one job in Studio before putting the arm in the loop.

### Building the job in Studio from fabPlane (`studio_load_job`)

The fastest reliable way found to control Studio (2026-11-27, Studio 1.0.41, LCS SDK 2.1): **drive Studio's own
window**. Studio has no API, its config files are encrypted, and its laser DLLs (`lcsDI`, `mark`, `executor`)
export only C++ classes, so calling the laser directly is not practical or safe. Its Qt widgets, however, are
visible to Windows UI Automation by object name, which fabPlane uses for everything:

| Step | How | Verified |
| --- | --- | --- |
| Start Studio | `__COMPAT_LAYER=RunAsInvoker` (no admin, so fabPlane may press its buttons) | yes |
| New document | Home page *Create* / tab `+` | yes |
| Import job | *Vector* (UIA Invoke on a background runspace) + Windows file dialog (`WM_SETTEXT` + `IDOK`) | yes |
| True size + place | W / H / X / Y boxes; **Studio scales every import to the lens field** (an 18 mm shape came in 70 mm wide), and the boxes take 2 decimals | yes |
| Hatch fill | posted click on *Fill* → Enable, Cross fill, Line spacing, Angle → Confirm | yes |
| Speed, Frequency, Pulse Width, Pass | value + posted Enter (Studio only keeps a typed value after Enter) | yes, read back |
| Power | no Power field is shown while the laser is disconnected | **not verified** |
| Start / finished / Stop | Start(F2); watch the button; Stop if Studio shows one | Start yes; marking not verified |

`export_laser_copper` writes `*.studio.svg` (only the copper to remove, cropped to itself; no board outline,
which Studio would also mark) and its bounds in the `.json`. `studio_load_job` places the shape so the board's
centre lands on *Board centre X/Y* (the jig). Studio's Y direction is assumed to be up, like other galvo
software: **check with Studio's Preview before the first board**. Only the ABLATE pass is built in Studio (the
cross-hatched isolation fill); the separate EDGE/CLEAN passes are LightBurn-only.

## How the arm knows where things are

No kinematics: positions are **taught**. Relax the arm (motors off), move it by hand to each station and
press Teach; fabPlane stores the raw servo positions in `<FABDESK_HOME>/laser-cell.json`:

`home`, `stackAbove`, `stackPick`, `jigAbove`, `jigPlace`, `clear`, `trayAbove`, `trayPlace`, plus
`gripperOpen` and `gripperClosed` (closed with nothing in the jaws).

- Every move waits until **every joint is within 18 steps (≈1.6°) of its goal**, so "arm is clear of the
  laser" is measured; a blocked joint times out and stops the cell instead of starting the laser.
- The gripper closes with a reduced torque limit; if it stops ≥ 40 steps short of the empty-closed
  position a board is held. No board at the stack = stack empty (ends the batch); no board at the jig
  after marking = warning.
- The board position on the laser is fixed mechanically: a **3D-printed corner jig** screwed to the bed.
  The job's origin is the board's bottom-left corner; place the job in Studio/LightBurn so that corner
  sits on the jig corner, once, then every board lines up.
- Joints are moved with per-joint speeds so all of them arrive together, and "above" stations give
  straight vertical approaches. Servos over 60 °C stop the cell at preflight.

Protocol: `packages/laser-cell/src/st3215.ts` (ST3215 packets, register map from NormaCore's driver).
Serial: `packages/laser-cell/src/serial.ts` — Windows through `kernel32` via `bun:ffi` (no native
add-on in the compiled core), Linux/macOS through `stty` + file I/O. NormaCore Station does not run on
Windows yet, which is why fabPlane talks to the servos directly; close Station or any servo tool first
(only one program can open the port).

## Copper job and settings

`export_laser_copper` (pure TypeScript, `packages/kicad/src/pcb-laser-copper.ts`) reads tracks, arcs,
vias, pads, filled zones and copper graphics, unions them and writes:

- **ABLATE** (fill, cross-hatch 0°/90°): the copper to remove. `isolation` (default) = a ring
  `isolationMm` (0.4 mm) around every copper island; `full` = all copper that is not a trace or pad.
- **EDGE** (line): every copper edge, for a clean isolation wall.
- **CLEAN** (fill, low power, high frequency): removes the dark film; `passes: 0` turns it off.
- **BOARD** (output off): the outline, for placing the job on the jig.
- A 0.4 mm copper-free dot at each through-hole pad centre to start the drill. Bottom copper is mirrored.

Starting points for the **Omni X 6 W (355 nm UV)** on 35 µm copper-clad FR-4, focused on the copper
(autofocus, 0 offset):

| Preset | Pass | Power | Speed | Frequency | Pulse | Line spacing | Passes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `omni-x-6w-70mm` (boards ≤ ~65 mm, default when it fits) | Remove copper | 100 % | 500 mm/s | 40 kHz | 1 | 0.015 mm, cross-hatch | 8 |
| | Edge | 100 % | 300 mm/s | 40 kHz | 1 | — | 3 |
| | Clean | 40 % | 1500 mm/s | 60 kHz | 1 | 0.015 mm, 45° | 1 |
| `omni-x-6w-150mm` | Remove copper | 100 % | 300 mm/s | 30 kHz | 1 | 0.02 mm, cross-hatch | 12 |
| | Edge | 100 % | 200 mm/s | 30 kHz | 1 | — | 4 |
| | Clean | 50 % | 1000 mm/s | 60 kHz | 1 | 0.02 mm, 45° | 1 |

**These are not a tested recipe.** They are derived from ComMarker's published Omni X tables (6 W metals
at 40 kHz, pulse 1, 0.02 mm; 12 W UV PCB example at 500 mm/s, 50 kHz, 0.03 mm, 2 passes) and slowed for
6 W. Before a real board:

1. Run Studio's (or LightBurn's) material-test grid on a scrap of the same blank: passes × speed.
2. Check with a continuity meter between neighbouring traces; add passes until isolated, stop before the
   FR-4 chars deeply. Studio's "Pulse" scale differs from LightBurn's Q-pulse in ns.
3. Brush and wipe with IPA after marking: ablated copper dust can bridge narrow gaps.
4. Prefer `isolation` mode. A 5 W UV review found full-area copper removal slow and prone to
   particle shorts; removing only the isolation rings is much faster.
5. Use the 70 mm lens when the board fits: much smaller, hotter spot at the same 6 W.

Cutting 1.6 mm FR-4 with 6 W UV takes very many passes: score and snap, or cut the outline mechanically.

## UV safety (read before an automatic run)

The Omni X is Class 1 only with its lid closed, and its cover sensor stops the laser when the lid opens.
For the arm to reach the bed the lid must stay open or the sensor must be off, and then the 355 nm beam
and its reflections are **not enclosed**. The cell refuses `cycle` and `laser-only` runs until
`safetyConfirmed` is set, meaning:

- a UV-blocking guard (orange/amber acrylic rated for 355 nm) encloses the laser **and** the arm, with
  its door wired to stop the laser;
- UV glasses rated OD 4+ at 355 nm for anyone near the cell, and fume extraction on;
- the Omni X **E-stop within reach**: neither route can stop the beam from fabPlane. Stop in fabPlane
  freezes the arm in place (keeping the board in the gripper) and ends the sequence.

`dry-run` moves the arm through every station with the laser never fired and needs no confirmation.

## Sources

- Omni X product and parameters: https://www.commarker.com/omni-x-uv-laser-engraver,
  https://support.commarker.com/hc/en-us/articles/49779932023449-Parameters-About-ComMarker-Omni-X
- ComMarker Studio: https://blog.commarker.com/archives/55775
- Omni X 6 W material tables: https://blog.commarker.com/archives/55268, https://blog.commarker.com/archives/55279
- UV PCB example (12 W): https://blog.commarker.com/archives/56093
- LightBurn UDP automation: https://docs.lightburnsoftware.com/2.1/Guides/AutomationWithUDP/
- LightBurn galvo I/O (foot switch, Busy/Done outputs): https://docs.lightburnsoftware.com/2.1/Reference/DeviceSettings/GalvoPorts/
- Omni X in LightBurn: https://forum.lightburnsoftware.com/t/commarker-omni-x-and-lightburn/184962
- ST3215 protocol: https://github.com/norma-core/norma-core/tree/main/software/drivers/st3215
- Reviews: https://newatlas.com/electronics/review-omni-x-uv-laser-engraver, https://www.tomshardware.com/maker-stem/commarker-omni-x-review
