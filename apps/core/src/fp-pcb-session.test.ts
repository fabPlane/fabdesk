import { describe, expect, test } from "bun:test";
import { DocumentType } from "@fp-pcb/proto";
import { FpPcbSessions, type ProjectSession } from "./fp-pcb-session";

function sessionsWithSchematic(state: boolean | undefined | null) {
  const sessions = new FpPcbSessions(() => ({}) as never);
  sessions.session = async () =>
    ({
      kicad: {
        currentSchematic: async () => (state === null ? null : { modified: async () => state }),
      },
    }) as unknown as ProjectSession;
  return sessions;
}

describe("placement schematic guard", () => {
  test("allows a saved schematic or no open schematic", async () => {
    await sessionsWithSchematic(false).assertSchematicSaved("/p");
    await sessionsWithSchematic(null).assertSchematicSaved("/p");
  });
  test("rejects unsaved or unmeasurable state without saving or closing the schematic", async () => {
    for (const state of [true, undefined])
      await expect(sessionsWithSchematic(state).assertSchematicSaved("/p")).rejects.toThrow(
        "save the open schematic",
      );
  });
});

import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function fixture(run: (f: Awaited<ReturnType<typeof simulatedProject>>) => Promise<void>) {
  const f = await simulatedProject();
  try {
    await run(f);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
}

async function simulatedProject() {
  const dir = await mkdtemp(join(tmpdir(), "session-restoration-"));
  const path = join(dir, "board.kicad_pcb");
  await writeFile(path, "checkpoint:pad-A");
  let loaded = "checkpoint:pad-A";
  let modified: boolean | undefined = false;
  let saves = 0,
    closes = 0,
    opens = 0;
  const document = {
    modified: async () => modified,
    close: async () => {
      closes++;
    },
    save: async () => {
      saves++;
      await writeFile(path, loaded);
      modified = false;
    },
  };
  const kicad = {
    currentBoard: async () => ({ ...document }),
    currentSchematic: async () => null,
    openBoard: async () => {
      opens++;
      loaded = await readFile(path, "utf8");
      return { ...document };
    },
  };
  const sessions = new FpPcbSessions(() => ({}) as never);
  sessions.session = async () => ({ kicad, path }) as unknown as ProjectSession;
  return {
    dir,
    path,
    sessions,
    live: () => loaded,
    counts: () => ({ saves, closes, opens }),
    edit: (text: string, state: boolean | undefined = true) => {
      loaded = text;
      modified = state;
    },
  };
}

describe("saved file/session restoration", () => {
  test("disk replacement between reconciliation and acquisition cannot bless stale loaded bytes", async () =>
    fixture(async f => {
      await f.sessions.board(f.dir);
      const session = await f.sessions.session(f.dir), original = session.kicad.currentBoard.bind(session.kicad);
      session.kicad.currentBoard = async () => { await writeFile(f.path, "external B"); return original(); };
      await expect(f.sessions.board(f.dir)).rejects.toThrow("changed while acquiring");
      expect(f.counts().saves).toBe(0);
      expect(await readFile(f.path, "utf8")).toBe("external B");
    }));
  test("a pre-reload handle cannot save even when disk returns to the same bytes", async () =>
    fixture(async f => {
      const old = await f.sessions.board(f.dir);
      await writeFile(f.path, "candidate");
      await f.sessions.board(f.dir);
      await writeFile(f.path, "checkpoint:pad-A");
      await f.sessions.board(f.dir);
      await expect(old.save()).rejects.toThrow("handle predates recovery/reload");
      expect(f.counts().saves).toBe(0);
    }));
  test("external checkpoint restore reloads before inspect and no-op save", async () =>
    fixture(async (f) => {
      await f.sessions.board(f.dir);
      f.edit("candidate:pad-B", false);
      await writeFile(f.path, "restored:pad-C");
      const board = await f.sessions.board(f.dir);
      expect(f.live()).toBe("restored:pad-C");
      await board.save();
      expect(await readFile(f.path, "utf8")).toBe("restored:pad-C");
      expect(f.counts()).toEqual({ saves: 1, closes: 2, opens: 2 });
    }));

  test("disk changes after acquiring document reject stale save and preserve both states", async () =>
    fixture(async (f) => {
      const board = await f.sessions.board(f.dir);
      f.edit("unsaved:candidate");
      await writeFile(f.path, "external:checkpoint");
      await expect(board.save()).rejects.toThrow("refusing stale save");
      expect(await readFile(f.path, "utf8")).toBe("external:checkpoint");
      expect(f.live()).toBe("unsaved:candidate");
      expect(f.counts().saves).toBe(0);
    }));

  test("unsaved and unknown live changes block reload without save or close", async () => {
    for (const state of [true, undefined])
      await fixture(async (f) => {
        await f.sessions.board(f.dir);
        const before = f.counts();
        f.edit("unsaved:live", state);
        await writeFile(f.path, "external:saved");
        await expect(f.sessions.board(f.dir)).rejects.toThrow("disk/session conflict");
        expect(f.counts()).toEqual(before);
        expect(f.live()).toBe("unsaved:live");
        expect(await readFile(f.path, "utf8")).toBe("external:saved");
      });
  });

  test("owned saves advance disk baseline and permit later unsaved live edits", async () =>
    fixture(async (f) => {
      const board = await f.sessions.board(f.dir);
      f.edit("owned:saved");
      await board.save();
      f.edit("owned:unsaved");
      await f.sessions.board(f.dir);
      expect(f.live()).toBe("owned:unsaved");
      expect(f.counts()).toEqual({ saves: 1, closes: 1, opens: 1 });
    }));

  test("removed saved file refuses overwrite", async () =>
    fixture(async (f) => {
      await f.sessions.board(f.dir);
      await rm(f.path);
      await expect(f.sessions.board(f.dir)).rejects.toThrow("removed on disk");
      expect(f.counts().saves).toBe(0);
    }));

  test("adopted sessions with unknown provenance reload saved state; unsaved adoption refuses", async () =>
    fixture(async (f) => {
      f.edit("stale:adopted", false);
      await f.sessions.board(f.dir);
      expect(f.live()).toBe("checkpoint:pad-A");
      await fixture(async (u) => {
        u.edit("unsaved:adopted");
        await expect(u.sessions.board(u.dir)).rejects.toThrow("disk/session conflict");
        expect(u.counts()).toEqual({ saves: 0, closes: 0, opens: 0 });
      });
    }));
});

test("pair reconciliation preflights unsaved schematic before closing changed saved PCB", async () => {
  await fixture(async f => {
    const schematicPath = join(f.dir, "board.kicad_sch");
    await writeFile(schematicPath, "schematic A");
    const original = await f.sessions.session(f.dir);
    let dirty = false, closes = 0;
    original.kicad.currentSchematic = async () => ({ modified: async () => dirty, close: async () => { closes++; } }) as never;
    original.kicad.openSchematic = async () => ({}) as never;
    await f.sessions.board(f.dir);
    const before = f.counts();
    dirty = true;
    await writeFile(f.path, "PCB B");
    await writeFile(schematicPath, "schematic B");
    await expect(f.sessions.board(f.dir)).rejects.toThrow("unsaved or unknown changes");
    expect(f.counts()).toEqual(before);
    expect(closes).toBe(1);
  });
});

test("saved-file recovery refuses unsaved state, blocks access while replacing, and expires handles", async () => {
  await fixture(async f => {
    const old = await f.sessions.board(f.dir);
    const session = await f.sessions.session(f.dir);
    let terminations = 0;
    session.ws = { close: async () => {} } as never;
    (f.sessions as any).open.set(f.dir, Promise.resolve(session));
    (f.sessions as any).bridge = () => ({ deleteSession: async () => { terminations++; } });
    f.edit("unsaved candidate");
    let replaced = false;
    await expect(f.sessions.withSavedFilesRecovery(f.dir, async () => { replaced = true; })).rejects.toThrow("unsaved or unknown");
    expect(replaced).toBe(false);
    expect(terminations).toBe(0);
    expect(f.live()).toBe("unsaved candidate");
    f.edit("checkpoint:pad-A", false);
    await f.sessions.withSavedFilesRecovery(f.dir, async () => {
      await expect(old.save()).rejects.toThrow("handle predates recovery/reload");
      await expect(f.sessions.withSavedFilesRecovery(f.dir, async () => {})).rejects.toThrow("already active");
      await writeFile(f.path, "restored");
    });
    expect(terminations).toBe(1);
    await expect(old.save()).rejects.toThrow("handle predates recovery/reload");
    expect(await readFile(f.path, "utf8")).toBe("restored");
  });
});

test("new project can retain unsaved documents until its first owned save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-new-project-"));
  const documents = new Map<
    number,
    { modified: () => Promise<boolean>; save: () => Promise<void> }
  >();
  const boardType = DocumentType.DOCTYPE_PCB,
    schematicType = DocumentType.DOCTYPE_SCHEMATIC;
  const kicad = {
    currentBoard: async () => documents.get(boardType) ?? null,
    currentSchematic: async () => documents.get(schematicType) ?? null,
    newProject: async (path: string) => {
      await writeFile(path, "project");
    },
    newDocument: async (type: number, path: string) => {
      await writeFile(path, "created stub");
      let dirty = true;
      const document = {
        modified: async () => dirty,
        save: async () => {
          await writeFile(path, "saved document");
          dirty = false;
        },
      };
      documents.set(type, document);
      return document;
    },
  };
  const sessions = new FpPcbSessions(() => ({ registerBundledLibraries: async () => {} }) as never);
  const session = { id: "new", kicad, path: null } as unknown as ProjectSession;
  sessions.session = async () => session;
  try {
    const first = await sessions.ensureProject(dir);
    const next = await sessions.ensureProject(dir);
    expect(await next.board.modified()).toBe(true);
    expect(await next.schematic.modified()).toBe(true);
    await first.board.save();
    await first.schematic.save();
    expect(await readFile(join(dir, "board.kicad_pcb"), "utf8")).toBe("saved document");
    await sessions.ensureProject(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-only project access does not register libraries or rewrite their saved tables", async () => {
  await fixture(async f => {
    let registrations = 0;
    const project = await f.sessions.session(f.dir);
    (f.sessions as any).bridge = () => ({ registerBundledLibraries: async () => { registrations++; } });
    await writeFile(join(f.dir, "board.kicad_pro"), "project");
    const sch = join(f.dir, "board.kicad_sch"); await writeFile(sch, "schematic");
    project.kicad.currentSchematic = async () => ({ modified: async () => false, close: async () => {}, save: async () => {} }) as never;
    project.kicad.openSchematic = async () => ({}) as never;
    await f.sessions.ensureProject(f.dir, { registerLibraries: false });
    expect(registrations).toBe(0);
    await f.sessions.ensureProject(f.dir);
    expect(registrations).toBe(1);
  });
});
