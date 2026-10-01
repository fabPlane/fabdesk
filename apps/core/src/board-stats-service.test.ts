import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError } from "@fabdesk/tools";
import { KicadCliError } from "@fabdesk/kicad";
import { createServices } from "./services";

test("statistics service classifies missing capability as unavailable and preserves runtime errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-stats-service-"));
  const path = join(dir, "kicad-cli");
  const services = await createServices({
    version: "test",
    channel: "internal",
    home: dir,
    settings: () => ({}) as never,
    projects: {} as never,
    bus: {} as never,
    routeRuns: {} as never,
    principal: () => null,
  });
  try {
    await Bun.write(
      path,
      '#!/usr/bin/env bun\nconsole.log("Subcommands:\\n  svg    Export SVG");\n',
    );
    await chmod(path, 0o755);
    const cli = { path, version: "10.99.0" };
    const opts = { board: join(dir, "board.kicad_pcb"), scratchFile: join(dir, "stats.json") };
    const error = await services.kicad.boardStats(cli, opts).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("does not provide 'pcb export stats'");
    await Bun.write(
      path,
      '#!/usr/bin/env bun\nconsole.error("broken runtime"); process.exit(3);\n',
    );
    await expect(services.kicad.boardStats(cli, opts)).rejects.toBeInstanceOf(KicadCliError);
  } finally {
    await services.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
