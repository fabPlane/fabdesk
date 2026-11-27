/**
 * Laser toolset: the copper-removal job for a ComMarker Omni X and the robot-arm laser cell
 * (ElRobot arm loading copper-clad blanks into the laser). See docs/laser-cell.md.
 */
import { join, sep } from "node:path";
import { z } from "zod/v4";
import { COPPER_PRESET_IDS, exportCopperLaserJob, type CopperLaserSummary } from "@fabdesk/kicad";
import { POSE_NAMES, type CellSnapshot, type LaserCellController } from "@fabdesk/laser-cell";
import { PROJECT_FILES, ensureDir } from "../fs";
import { ToolError, defineTool, type ToolContext } from "../registry";
import { expectedPcbSource, withPcbOutput } from "../pcb-output";
import { ok, p, requireBoard } from "./common";

const rel = (project: { dir: string }, abs: string) => (abs.startsWith(project.dir) ? abs.slice(project.dir.length + 1) : abs);

/** Drop undefined fields (exactOptionalPropertyTypes). */
function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

const pass = z
  .object({
    powerPct: z.number().min(0).max(100).optional(),
    speedMmPerS: z.number().positive().optional(),
    frequencyKhz: z.number().positive().optional(),
    passes: z.number().int().min(0).max(100).optional(),
    intervalMm: z.number().min(0).max(1).optional(),
  })
  .strict()
  .optional();

export const export_laser_copper = defineTool({
  name: "export_laser_copper",
  boardScoped: true,
  toolset: "laser",
  title: "Export laser copper-removal job",
  description:
    "Turn the board's copper layer into a ComMarker Omni X (355 nm UV, 6 W) copper-removal job for a copper-clad blank: exports/laser/<side>-Cu-laser-<mode>.lbrn2 (LightBurn: ABLATE fill, EDGE cleanup, CLEAN pass, BOARD guide), a filled SVG for ComMarker Studio, and a JSON summary with area, estimated marking time and settings. mode=isolation (default) removes a ring isolationMm wide around every copper island; mode=full removes all non-copper. Bottom copper is mirrored by default. Presets: omni-x-6w-70mm (boards up to ~65 mm, default when it fits) and omni-x-6w-150mm. Settings are unverified starting points for a material test on scrap. Pure TypeScript.",
  inputSchema: {
    expectedSourceSha256: expectedPcbSource,
    side: z.enum(["F", "B"]).default("F").describe("Copper layer to remove copper from"),
    mode: z.enum(["isolation", "full"]).default("isolation"),
    isolationMm: z.number().min(0.1).max(5).optional().describe("Isolation ring width in mm (default 0.4)"),
    preset: z.enum(COPPER_PRESET_IDS).optional().describe("Lens preset; default picks the 70 mm lens when the board fits"),
    mirror: z.boolean().optional().describe("Mirror the artwork (default: true for B, false for F)"),
    drillMarkMm: z.number().min(0).max(2).optional().describe("Copper-free dot at through-hole pad centres to start the drill (default 0.4, 0 = off)"),
    ablate: pass.describe("Overrides for the copper-removal fill passes"),
    edge: pass.describe("Overrides for the copper-edge line passes"),
    clean: pass.describe("Overrides for the final cleaning pass (passes 0 = off)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  longRunning: true,
  handler: async (args, ctx) =>
    withPcbOutput(ctx, args.expectedSourceSha256, async ctx => {
      const project = ctx.requireProject();
      const board = await requireBoard(project);
      const outDir = await ensureDir(p(project, PROJECT_FILES.exports, "laser"));
      ctx.progress(0.2, "building copper-removal job");
      let summary: CopperLaserSummary;
      try {
        summary = await exportCopperLaserJob({
          board,
          outDir,
          side: args.side,
          mode: args.mode,
          ...(args.isolationMm != null ? { isolationMm: args.isolationMm } : {}),
          ...(args.preset ? { preset: args.preset } : {}),
          ...(args.mirror != null ? { mirror: args.mirror } : {}),
          ...(args.drillMarkMm != null ? { drillMarkMm: args.drillMarkMm } : {}),
          settings: {
            ...(args.ablate ? { ablate: defined(args.ablate) } : {}),
            ...(args.edge ? { edge: defined(args.edge) } : {}),
            ...(args.clean ? { clean: defined(args.clean) } : {}),
          },
        });
      } catch (error) {
        if (error instanceof Error && error.name === "CopperLaserOptionsError") throw new ToolError(error.message, "invalid_args");
        throw error;
      }
      ctx.progress(1, "done");
      const s = summary.settings.ablate;
      const minutes = Math.max(1, Math.round(summary.estimatedSeconds / 60));
      const warn = summary.warnings.length ? `\nWarnings:\n${summary.warnings.map(w => `- ${w}`).join("\n")}` : "";
      const files = [summary.files.lbrn2, summary.files.svg, summary.files.studioSvg, summary.files.lmc, summary.files.json];
      return ok(
        `Exported ${summary.side}.Cu ${summary.mode} copper removal for a ${summary.boardMm.width} × ${summary.boardMm.height} mm blank (${summary.preset}${summary.mirror ? ", mirrored" : ""}): ${summary.areaMm2.ablate} mm² to remove, about ${minutes} min. Starting-point fill ${s.powerPct}% · ${s.speedMmPerS} mm/s · ${s.frequencyKhz} kHz · ${s.intervalMm} mm cross-hatch · ${s.passes} passes; edge ${summary.settings.edge.passes} passes. Run a material test on scrap and check isolation with a meter first.${warn}\n${files.map(f => `- ${rel(project, f)}`).join("\n")}`,
        { ...summary, files: files.map(f => rel(project, f)), path: rel(project, summary.files.lbrn2) },
      );
    }),
});

function requireCell(ctx: ToolContext): LaserCellController {
  const cell = ctx.services.laserCell;
  if (!cell) throw new ToolError("The laser cell is not available in this fabPlane host (it needs the desktop app's local core).", "unavailable");
  return cell;
}

function describe(snapshot: CellSnapshot): string {
  const run = snapshot.run;
  const lines = [
    `Arm: ${snapshot.arm.connected ? `connected on ${snapshot.arm.port}` : snapshot.arm.port ? `not connected (${snapshot.arm.port})` : "no port chosen"}${snapshot.arm.error ? ` — ${snapshot.arm.error}` : ""}`,
    `Laser: ${snapshot.config.laser.driver}${snapshot.laser ? ` — ${snapshot.laser.state}: ${snapshot.laser.detail}` : ""}`,
    `Taught: ${snapshot.poses.filter(x => x.taught).length}/${snapshot.poses.length} positions${snapshot.missing.length ? ` (missing ${snapshot.missing.join(", ")})` : ""}`,
    `UV guard confirmed: ${snapshot.config.safetyConfirmed ? "yes" : "no"}`,
    run.active ? `Running ${run.mode}: board ${run.board}/${run.boards}, ${run.note ?? run.step}` : run.error ? `Last run stopped: ${run.error}` : run.done ? `Last run finished ${run.done}/${run.boards} board(s)` : "Idle",
  ];
  return lines.join("\n");
}

const TEACH_NAMES = [...POSE_NAMES, "gripperOpen", "gripperClosed"] as const;

export const laser_cell = defineTool({
  name: "laser_cell",
  toolset: "laser",
  scope: "global",
  localOnly: true,
  title: "Laser cell (robot arm + Omni X)",
  description:
    "Drive the laser cell on this machine: an ElRobot arm (ST3215 servos over USB) that loads copper-clad blanks into a ComMarker Omni X and starts it through ComMarker Studio (studio-window: fabPlane presses Studio's own Start button and watches it finish; or studio-footswitch: USB relay on the foot-switch input) or LightBurn (UDP). Actions: status, ports, configure (arm/laser settings, safetyConfirmed), connect, disconnect, relax (motors off for hand-teaching), hold, teach (record the current arm position as a named station), move (go to a taught station, slow), use_job (point the cell at a project's exported LightBurn job and set the Studio mark time from its estimate), usb_devices / usb_probe / preview (usb-lmc route, fabPlane's own experimental driver for BJJCZ boards, by USB cable or over Wi-Fi through the fabPlane laser bridge (lmc.connection network, host, port, token): list USB devices, read the board's version without moving anything, red-light frame around the job; preview needs safetyConfirmed), studio_open (start ComMarker Studio without admin rights), studio_load_job (studio-window route: start ComMarker Studio if needed and build the project's newest export_laser_copper job in it: import, true size and position on the jig, hatch fill and the preset's speed/frequency/pulse/passes, then read back what Studio shows), run (boards N, mode cycle|dry-run|laser-only; returns at once, poll status), stop, footswitch_press (one 250 ms click of the foot-switch relay = one Studio job), footswitch_hold / footswitch_release (pedal down / up). The cell refuses an automatic run until safetyConfirmed: the Omni X lid has to be open or its cover sensor off for the arm to reach the bed, so a UV-blocking guard must enclose the cell. Moving hardware: only act when the user asked.",
  inputSchema: {
    action: z.enum(["status", "ports", "configure", "connect", "disconnect", "relax", "hold", "teach", "move", "use_job", "studio_open", "studio_load_job", "usb_devices", "usb_probe", "preview", "run", "stop", "footswitch_press", "footswitch_hold", "footswitch_release"]),
    name: z.enum(TEACH_NAMES).optional().describe("Station for teach / move"),
    arm: z
      .object({
        port: z.string().nullable().optional(),
        baud: z.number().int().positive().optional(),
        jointIds: z.array(z.number().int().min(0).max(253)).optional(),
        gripperId: z.number().int().min(0).max(253).optional(),
        speed: z.number().int().min(50).max(3400).optional(),
        approachSpeed: z.number().int().min(20).max(3400).optional(),
      })
      .strict()
      .optional(),
    laser: z
      .object({
        driver: z.enum(["studio-footswitch", "studio-window", "lightburn", "usb-lmc", "simulator"]).optional(),
        lmc: z.object({
          fieldMm: z.number().min(10).max(400).optional(),
          centerMm: z.object({ x: z.number(), y: z.number() }).optional(),
          flipX: z.boolean().optional(),
          flipY: z.boolean().optional(),
          swapXY: z.boolean().optional(),
          source: z.enum(["co2", "fiber"]).optional(),
          laserPin: z.number().int().min(0).max(15).optional(),
          lightPin: z.number().int().min(0).max(15).optional(),
          maxPowerPct: z.number().min(1).max(100).optional(),
          initBoard: z.boolean().optional(),
          usbIndex: z.number().int().min(0).max(8).optional(),
          connection: z.enum(["usb", "network"]).optional(),
          host: z.string().optional(),
          port: z.number().int().min(1).max(65535).optional(),
          token: z.string().optional(),
        }).strict().optional(),
        studioCompletion: z.enum(["watch", "timer"]).optional(),
        studioExe: z.string().nullable().optional(),
        studioBoardCenterMm: z.object({ x: z.number(), y: z.number() }).optional(),
        relayKind: z.enum(["lcus", "arduino"]).optional(),
        relayPort: z.string().nullable().optional(),
        relayChannel: z.number().int().min(1).max(8).optional(),
        markSeconds: z.number().min(1).optional(),
        marginSeconds: z.number().min(0).optional(),
        jobPath: z.string().nullable().optional(),
        frameSeconds: z.number().min(0).max(60).optional(),
        markTimeoutMinutes: z.number().min(1).max(600).optional(),
        lightburnHost: z.string().optional(),
      })
      .strict()
      .optional(),
    safetyConfirmed: z.boolean().optional(),
    project: z.string().optional().describe("use_job: project id or path whose exports/laser job to use"),
    job: z.string().optional().describe("use_job: path inside the project, default the newest exports/laser/*.lbrn2"),
    seconds: z.number().min(1).max(60).optional().describe("preview: how long to show the red-light frame"),
    boards: z.number().int().min(1).max(500).optional().describe("run: number of boards (stops early when the stack is empty)"),
    mode: z.enum(["cycle", "dry-run", "laser-only"]).optional().describe("run: cycle (default), dry-run (arm only, laser never fires) or laser-only"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  handler: async (args, ctx) => {
    const cell = requireCell(ctx);
    const fail = (error: unknown): never => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error instanceof Error ? error.message : String(error), "precondition");
    };
    try {
      switch (args.action) {
        case "status": {
          const snap = await cell.snapshot();
          return ok(describe(snap), snap);
        }
        case "ports": {
          const ports = await cell.listPorts();
          return ok(ports.length ? ports.map(port => `- ${port.label}`).join("\n") : "No serial ports found. Plug in the servo board / USB relay.", { ports });
        }
        case "configure": {
          const config = await cell.configure({
            ...(args.arm ? { arm: defined(args.arm) } : {}),
            ...(args.laser ? { laser: defined(args.laser) } : {}),
            ...(args.safetyConfirmed !== undefined ? { safetyConfirmed: args.safetyConfirmed } : {}),
          });
          return ok("Saved laser cell settings.", { config });
        }
        case "connect":
          await cell.connectArm();
          break;
        case "disconnect":
          await cell.disconnectArm();
          break;
        case "relax":
          await cell.relax();
          break;
        case "hold":
          await cell.hold();
          break;
        case "teach": {
          if (!args.name) throw new ToolError("teach needs name", "invalid_args");
          const taught = await cell.teach(args.name);
          return ok(`Taught ${args.name}.`, { name: args.name, taught });
        }
        case "move": {
          if (!args.name || args.name === "gripperOpen" || args.name === "gripperClosed") throw new ToolError("move needs a station name", "invalid_args");
          await cell.moveTo(args.name);
          break;
        }
        case "use_job": {
          const project = args.project ? await ctx.services.projects.resolve(args.project) : ctx.project;
          if (!project) throw new ToolError(args.project ? `project ${args.project} not found` : "use_job needs a project", "invalid_args");
          const { readdir, readFile, stat } = await import("node:fs/promises");
          const dir = p(project, PROJECT_FILES.exports, "laser");
          let job = args.job ? join(project.dir, args.job) : null;
          if (!job) {
            const files = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith(".lbrn2"));
            const dated = await Promise.all(files.map(async f => ({ f, t: (await stat(join(dir, f))).mtimeMs })));
            const newest = dated.sort((a, b) => b.t - a.t)[0];
            if (!newest) throw new ToolError("No exports/laser/*.lbrn2 yet; run export_laser_copper first", "precondition");
            job = join(dir, newest.f);
          }
          if (!job.startsWith(project.dir + sep) || !job.endsWith(".lbrn2")) throw new ToolError("job must be a .lbrn2 file inside the project", "invalid_args");
          const summary = JSON.parse(await readFile(job.replace(/\.lbrn2$/, ".json"), "utf8").catch(() => "{}")) as { estimatedSeconds?: number };
          const config = await cell.configure({ laser: { jobPath: job, ...(summary.estimatedSeconds ? { markSeconds: Math.min(24 * 3600, Math.ceil(summary.estimatedSeconds * 1.15)) } : {}) } });
          return ok(`The cell now uses ${rel(project, job)}${summary.estimatedSeconds ? `; Studio mark time set to ${config.laser.markSeconds} s (estimate + 15 %). Replace it with Studio's own estimate after loading the job there.` : "."}`, { config });
        }
        case "usb_devices": {
          const devices = await cell.usbDevices();
          const found = devices.some(d => d.laser);
          return ok(`${devices.length} USB device(s): ${devices.map(d => `${d.vid}:${d.pid}${d.laser ? " (laser board)" : ""}`).join(", ")}.${found ? "" : " No BJJCZ laser board (9588:9899) is connected."}`, { devices });
        }
        case "usb_probe": {
          const probe = await cell.usbProbe();
          return ok(`Laser board answered over USB: version ${probe.version.map(w => w.toString(16)).join(".")}, status 0x${probe.status.toString(16)}.`, probe);
        }
        case "preview":
          await cell.preview(args.seconds ?? 5);
          break;
        case "studio_open": {
          const result = await cell.openStudio();
          return ok(result === "started" ? "Started ComMarker Studio." : "ComMarker Studio is already open.", { result });
        }
        case "studio_load_job": {
          const project = args.project ? await ctx.services.projects.resolve(args.project) : ctx.project;
          if (!project) throw new ToolError(args.project ? `project ${args.project} not found` : "studio_load_job needs a project", "invalid_args");
          const { readdir, readFile, stat } = await import("node:fs/promises");
          const dir = p(project, PROJECT_FILES.exports, "laser");
          let summaryPath = args.job ? join(project.dir, args.job).replace(/.(lbrn2|svg|studio.svg)$/, ".json") : null;
          if (!summaryPath) {
            // Job summaries only: the app writes *.revision.json records next to every exported file.
            const files = (await readdir(dir).catch(() => [] as string[])).filter(f => /-Cu-laser-[a-z]+.json$/.test(f));
            const dated = await Promise.all(files.map(async f => ({ f, t: (await stat(join(dir, f))).mtimeMs })));
            const newest = dated.sort((a, b) => b.t - a.t)[0];
            if (!newest) throw new ToolError("No exports/laser job yet; run export_laser_copper first", "precondition");
            summaryPath = join(dir, newest.f);
          }
          if (!summaryPath.startsWith(project.dir + sep)) throw new ToolError("job must be inside the project", "invalid_args");
          type Summary = { boardMm: { width: number; height: number }; estimatedSeconds?: number; settings: { ablate: { powerPct: number; speedMmPerS: number; frequencyKhz: number; pulseNs: number; passes: number; intervalMm: number; angleDeg: number; angleStepDeg: number } }; files?: unknown; studio?: { x: number; y: number; width: number; height: number } | null };
          const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Summary;
          // The summary records where the export was built; the Studio SVG now sits next to the summary.
          const studioSvg = summaryPath.replace(/.json$/, ".studio.svg");
          if (!summary.studio || !(await stat(studioSvg).then(() => true, () => false))) throw new ToolError("This laser job was exported before Studio support; run export_laser_copper again", "precondition");
          const centre = (await cell.snapshot()).config.laser.studioBoardCenterMm;
          const b = summary.studio;
          const a = summary.settings.ablate;
          const result = await cell.studioLoadJob({
            file: studioSvg,
            widthMm: b.width,
            heightMm: b.height,
            xMm: centre.x + (b.x + b.width / 2 - summary.boardMm.width / 2),
            yMm: centre.y + (b.y + b.height / 2 - summary.boardMm.height / 2),
            fill: { spacingMm: a.intervalMm, angleDeg: a.angleDeg, cross: a.angleStepDeg === 90 },
            settings: { powerPct: a.powerPct, speedMmPerS: a.speedMmPerS, frequencyKhz: a.frequencyKhz, pulse: a.pulseNs, passes: a.passes },
          });
          if (summary.estimatedSeconds) await cell.configure({ laser: { markSeconds: Math.min(24 * 3600, Math.ceil(summary.estimatedSeconds * 1.15)) } });
          const shown = Object.entries(result.values ?? {}).filter(([, v]) => typeof v !== "object").map(([k, v]) => `${k} ${String(v)}`).join(", ");
          const notes = result.log.map(l => `\n- ${l}`).join("");
          return ok(`Loaded ${rel(project, studioSvg)} into ComMarker Studio. Studio shows: ${shown}.${notes}\nCheck the position with Studio's Preview before the first board.`, { values: result.values, log: result.log });
        }
        case "run":
          await cell.run({ boards: args.boards ?? 1, mode: args.mode ?? "cycle" });
          break;
        case "stop":
          await cell.stop();
          break;
        case "footswitch_press":
        case "footswitch_hold":
        case "footswitch_release": {
          const pressed = await cell.footswitch(args.action === "footswitch_press" ? "press" : args.action === "footswitch_hold" ? "hold" : "release");
          return ok(args.action === "footswitch_press" ? "Pressed the foot switch once." : pressed ? "Foot switch is held down." : "Foot switch released.", { pressed });
        }
      }
    } catch (error) {
      fail(error);
    }
    const snap = await cell.snapshot({ probe: args.action !== "run" });
    return ok(describe(snap), snap);
  },
});

export const laserTools = [export_laser_copper, laser_cell];
