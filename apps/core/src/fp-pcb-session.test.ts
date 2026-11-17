import { parseLibraryTable } from "./project-library-tables";
import { describe, expect, test } from "bun:test";
import { DocumentType } from "@fp-pcb/proto";
import { inspectProjectBoardSources } from "@fabdesk/tools";
import { resolveNativeBoardBinding, withNativeBoardBinding } from "./assembly-board-binding";
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
    fixture(async (f) => {
      await f.sessions.board(f.dir);
      const session = await f.sessions.session(f.dir),
        original = session.kicad.currentBoard.bind(session.kicad);
      session.kicad.currentBoard = async () => {
        await writeFile(f.path, "external B");
        return original();
      };
      await expect(f.sessions.board(f.dir)).rejects.toThrow("changed while acquiring");
      expect(f.counts().saves).toBe(0);
      expect(await readFile(f.path, "utf8")).toBe("external B");
    }));
  test("a pre-reload handle cannot save even when disk returns to the same bytes", async () =>
    fixture(async (f) => {
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

  test("a bridge save adopted by its owner permits the owner's later unsaved edits", async () =>
    fixture(async (f) => {
      await f.sessions.board(f.dir);
      // The route job refills and saves inside the bridge, then applies copper without saving.
      await writeFile(f.path, "bridge:refilled");
      f.edit("bridge:refilled+routed");
      await expect(f.sessions.board(f.dir)).rejects.toThrow("disk/session conflict");
      await f.sessions.adoptSaved(f.dir, "board.kicad_pcb");
      const board = await f.sessions.board(f.dir);
      await board.save();
      expect(await readFile(f.path, "utf8")).toBe("bridge:refilled+routed");
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
  await fixture(async (f) => {
    const schematicPath = join(f.dir, "board.kicad_sch");
    await writeFile(schematicPath, "schematic A");
    const original = await f.sessions.session(f.dir);
    let dirty = false,
      closes = 0;
    original.kicad.currentSchematic = async () =>
      ({
        modified: async () => dirty,
        close: async () => {
          closes++;
        },
      }) as never;
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
  await fixture(async (f) => {
    const old = await f.sessions.board(f.dir);
    const session = await f.sessions.session(f.dir);
    let terminations = 0;
    session.ws = { close: async () => {} } as never;
    (f.sessions as any).open.set(f.dir, Promise.resolve(session));
    (f.sessions as any).bridge = () => ({
      deleteSession: async () => {
        terminations++;
      },
    });
    f.edit("unsaved candidate");
    let replaced = false;
    await expect(
      f.sessions.withSavedFilesRecovery(f.dir, async () => {
        replaced = true;
      }),
    ).rejects.toThrow("unsaved or unknown");
    expect(replaced).toBe(false);
    expect(terminations).toBe(0);
    expect(f.live()).toBe("unsaved candidate");
    f.edit("checkpoint:pad-A", false);
    await f.sessions.withSavedFilesRecovery(f.dir, async () => {
      await expect(old.save()).rejects.toThrow("handle predates recovery/reload");
      await expect(f.sessions.withSavedFilesRecovery(f.dir, async () => {})).rejects.toThrow(
        "already active",
      );
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
  await fixture(async (f) => {
    let registrations = 0;
    const project = await f.sessions.session(f.dir);
    (f.sessions as any).bridge = () => ({
      registerBundledLibraries: async () => {
        registrations++;
      },
    });
    await writeFile(join(f.dir, "board.kicad_pro"), "project");
    const sch = join(f.dir, "board.kicad_sch");
    await writeFile(sch, "schematic");
    project.kicad.currentSchematic = async () =>
      ({ modified: async () => false, close: async () => {}, save: async () => {} }) as never;
    project.kicad.openSchematic = async () => ({}) as never;
    await f.sessions.ensureProject(f.dir, { registerLibraries: false });
    expect(registrations).toBe(0);
    await f.sessions.ensureProject(f.dir);
    expect(registrations).toBe(1);
  });
});

describe("concurrent saved document reconciliation", () => {
  test("parallel routing inventory reads reload an unknown board once", async () =>
    fixture(async (f) => {
      await Promise.all(Array.from({ length: 8 }, () => f.sessions.board(f.dir)));
      expect(f.counts()).toEqual({ saves: 0, closes: 1, opens: 1 });
    }));
  test("parallel reads of externally replaced saved bytes reload once", async () =>
    fixture(async (f) => {
      await f.sessions.board(f.dir);
      await writeFile(f.path, "external saved replacement");
      await Promise.all(Array.from({ length: 8 }, () => f.sessions.board(f.dir)));
      expect(f.counts()).toEqual({ saves: 0, closes: 2, opens: 2 });
      expect(f.live()).toBe("external saved replacement");
    }));
  test("a refused reconciliation does not unblock a second reader by discarding live work", async () =>
    fixture(async (f) => {
      await f.sessions.board(f.dir);
      f.edit("unsaved live copper");
      await writeFile(f.path, "external saved replacement");
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => f.sessions.board(f.dir)),
      );
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      expect(f.counts()).toEqual({ saves: 0, closes: 1, opens: 1 });
      expect(f.live()).toBe("unsaved live copper");
    }));
});

test("native save checks captured assembly ownership immediately before the save RPC", async () =>
  fixture(async f => {
    const declaration = join(f.dir, "fabplane.assembly.json");
    await writeFile(declaration, JSON.stringify({ contract: "fabplane.assembly.v1", sources: [{ id: "main", name: "Main", location: "project", directory: "." }], instances: [{ id: "main-1", name: "Main", sourceId: "main" }], connections: [] }));
    const project = { id: "project", dir: f.dir }, inspection = await inspectProjectBoardSources(project);
    const binding = await resolveNativeBoardBinding(project, { sourceId: "main", manifestSha256: inspection.manifestSha256! });
    const board = await f.sessions.board(binding.boardDir);
    f.edit("unsaved:candidate");
    await expect(withNativeBoardBinding(binding, async () => {
      await writeFile(declaration, "{}");
      await board.save();
    })).rejects.toThrow("ownership changed");
    expect(f.counts().saves).toBe(0);
    expect(await readFile(f.path, "utf8")).toBe("checkpoint:pad-A");
    expect(f.live()).toBe("unsaved:candidate");
  }));

test("bundled library setup is shared, reused only for unchanged tables, and retried after failure", async () => {
  await fixture(async f => {
    const session = await f.sessions.session(f.dir);
    f.sessions.session = async () => session;
    await writeFile(join(f.dir, "board.kicad_pro"), "project");
    await writeFile(join(f.dir, "board.kicad_sch"), "schematic");
    session.kicad.currentSchematic = async () => ({ modified: async () => false, close: async () => {}, save: async () => {} }) as never;
    session.kicad.openSchematic = session.kicad.currentSchematic as never;
    let registrations = 0, fail = false;
    (f.sessions as any).bridge = () => ({ registerBundledLibraries: async () => {
      registrations++;
      await new Promise(resolve => setTimeout(resolve, 5));
      if (fail) throw new Error("library setup timed out");
      await writeFile(join(f.dir, "sym-lib-table"), `registered ${registrations}`);
    } });
    await Promise.all(Array.from({ length: 6 }, () => f.sessions.ensureProject(f.dir)));
    expect(registrations).toBe(1);
    await f.sessions.ensureProject(f.dir);
    expect(registrations).toBe(1);
    await writeFile(join(f.dir, "fp-lib-table"), "external library change");
    await f.sessions.ensureProject(f.dir);
    expect(registrations).toBe(2);
    await writeFile(join(f.dir, "sym-lib-table"), "external symbols");
    fail = true;
    await expect(f.sessions.ensureProject(f.dir)).rejects.toThrow("library setup timed out");
    fail = false;
    await f.sessions.ensureProject(f.dir);
    expect(registrations).toBe(4);
    // A replacement native session must establish its own library state.
    f.sessions.session = async () => ({ ...session, id: "replacement" });
    await f.sessions.ensureProject(f.dir);
    expect(registrations).toBe(5);
    await rm(join(f.dir, "fp-lib-table"));
    await f.sessions.ensureProject(f.dir, { registerLibraries: false });
    expect(registrations).toBe(5);
  });
});

test("bundled library setup re-adds project rows KiCad's in-memory table save dropped", async () => {
  await fixture(async f => {
    const session = await f.sessions.session(f.dir);
    f.sessions.session = async () => session;
    await writeFile(join(f.dir, "board.kicad_pro"), "project");
    await writeFile(join(f.dir, "board.kicad_sch"), "schematic");
    session.kicad.currentSchematic = async () => ({ modified: async () => false, close: async () => {}, save: async () => {} }) as never;
    session.kicad.openSchematic = session.kicad.currentSchematic as never;
    const fp = join(f.dir, "fp-lib-table");
    const bundled = `\t(lib (name "Device") (type "KiCad") (uri "/opt/Device.pretty") (options "") (descr "Bundled KiCad footprint library"))`;
    const custom = `\t(lib (name "Pilot") (type "KiCad") (uri "\${KIPRJMOD}/Pilot.pretty") (options "") (descr "project"))`;
    const tableOf = (rows: string[]) => `(fp_lib_table\n\t(version 7)\n${rows.join("\n")}\n)\n`;
    let memory = [bundled];
    const added: unknown[] = [];
    (session.kicad as any).libraries = {
      tables: async () => parseLibraryTable(tableOf(memory)).map(row => ({ nickname: row.name, uri: row.uri, type: row.type, options: row.options, description: row.descr, enabled: !row.disabled, hidden: row.hidden })),
      addTableRow: async (kind: string, scope: string, row: { nickname: string; uri: string; description: string }, replace: boolean) => {
        added.push({ kind, scope, nickname: row.nickname, uri: row.uri, replace });
        memory = [...memory.filter(r => !r.includes(`"${row.nickname}"`)), `\t(lib (name "${row.nickname}") (type "KiCad") (uri "${row.uri}") (options "") (descr "${row.description}"))`];
        await writeFile(fp, tableOf(memory));
      },
    };
    // Registration rewrites the saved table from KiCad's memory, like the real bridge does.
    (f.sessions as any).bridge = () => ({ registerBundledLibraries: async () => { await writeFile(fp, tableOf(memory)); } });
    await writeFile(fp, tableOf([bundled]));
    await f.sessions.ensureProject(f.dir);
    expect(added).toEqual([]);
    await writeFile(fp, tableOf([bundled, custom]));
    await f.sessions.ensureProject(f.dir);
    expect(added).toEqual([{ kind: "footprint", scope: "project", nickname: "Pilot", uri: "${KIPRJMOD}/Pilot.pretty", replace: true }]);
    expect(await readFile(fp, "utf8")).toContain('"Pilot"');
    // The restored table is the new baseline: an unchanged table does not register again.
    await f.sessions.ensureProject(f.dir);
    expect(added.length).toBe(1);
  });
});

test("library restoration preserves a newer external table edit instead of replaying an old snapshot", async () => fixture(async f => {
  const session = await f.sessions.session(f.dir), path = join(f.dir, "fp-lib-table");
  const table = (uri: string) => `(fp_lib_table (lib (name "Pilot") (type "KiCad") (uri "${uri}") (options "") (descr "project")))`;
  await writeFile(path, table("old.pretty"));
  let adds = 0;
  (session.kicad as any).libraries = { tables: async () => [], addTableRow: async () => { adds++; throw Error("must not overwrite newer disk edit"); } };
  await expect(f.sessions.preservingProjectLibraries(f.dir, session, async () => {
    await writeFile(path, table("newer-external.pretty"));
  })).rejects.toThrow("newer saved table was kept");
  expect(await readFile(path, "utf8")).toContain("newer-external.pretty");
  expect(adds).toBe(0);
}));

test("library writes on the same native session capture snapshots serially", async () => fixture(async f => {
  const session = await f.sessions.session(f.dir), events: string[] = [];
  let unlock!: () => void;
  const blocked = new Promise<void>(resolve => { unlock = resolve; });
  const first = f.sessions.preservingProjectLibraries(f.dir, session, async () => { events.push("first"); await blocked; events.push("first done"); });
  const second = f.sessions.preservingProjectLibraries(f.dir, session, async () => { events.push("second"); });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(events).toEqual(["first"]);
  unlock(); await Promise.all([first, second]);
  expect(events).toEqual(["first", "first done", "second"]);
}));

for (const kind of ["footprint", "symbol"] as const) for (const failure of ["failure", "cancellation"] as const) {
  test(`${kind} table survives ${failure} after native registration drops a project row`, async () => fixture(async f => {
    const session = await f.sessions.session(f.dir);
    const filename = kind === "footprint" ? "fp-lib-table" : "sym-lib-table";
    const path = join(f.dir, filename), table = kind === "footprint" ? "fp_lib_table" : "sym_lib_table";
    await writeFile(path, `(${table} (lib (name "Pilot") (type "KiCad") (uri "project-local") (options "") (descr "Bundled KiCad ${kind} library") (hidden)))`);
    let restored = false;
    (session.kicad as any).libraries = {
      tables: async () => [],
      addTableRow: async (actualKind: string, _scope: string, row: { nickname: string; uri: string; description: string; hidden: boolean }) => {
        expect(actualKind).toBe(kind); expect(row.hidden).toBe(true);
        expect(row.description).toBe(`Bundled KiCad ${kind} library`);
        await writeFile(path, `(${table} (lib (name "${row.nickname}") (uri "${row.uri}") (hidden)))`); restored = true;
      },
    };
    const error = failure === "cancellation" ? new DOMException("cancelled", "AbortError") : Error("registration failed");
    await expect(f.sessions.preservingProjectLibraries(f.dir, session, async () => {
      await writeFile(path, `(${table})`); throw error;
    })).rejects.toBe(error);
    expect(restored).toBe(true); expect(await readFile(path, "utf8")).toContain("project-local");
  }));
}

for (const kind of ["footprint","symbol"] as const) test(`${kind} preservation survives native session loss and reconnect`,async()=>fixture(async f=>{
 const session=await f.sessions.session(f.dir),file=join(f.dir,kind==="footprint"?"fp-lib-table":"sym-lib-table"),root=kind==="footprint"?"fp_lib_table":"sym_lib_table";
 const table=(uri:string)=>`(${root} (lib (name "Pilot") (type "KiCad") (uri "${uri}")))`;
 await writeFile(file,table("original-project-library"));let gone=false,reconnected=false;
 (session.kicad as any).libraries={tables:async()=>{if(gone)throw Error("connection closed");return [];},addTableRow:async(_kind:string,_scope:string,row:{uri:string})=>{await writeFile(file,table(row.uri));}};
 const originalRelease=f.sessions.release.bind(f.sessions);f.sessions.release=async()=>{gone=false;reconnected=true;};f.sessions.session=async()=>session;
 await expect(f.sessions.preservingProjectLibraries(f.dir,session,async()=>{await writeFile(file,`(${root})`);gone=true;throw Error("connection closed");})).rejects.toThrow("connection closed");
 expect(reconnected).toBe(true);expect(await readFile(file,"utf8")).toContain("original-project-library");f.sessions.release=originalRelease;
}));
test("an external edit before a client native table save is refused and both versions are retained",async()=>fixture(async f=>{
 const session=await f.sessions.session(f.dir),file=join(f.dir,"fp-lib-table"),table=(uri:string)=>`(fp_lib_table (lib (name "Pilot") (uri "${uri}")))`;
 await writeFile(file,table("old.pretty"));let nativeWrites=0;
 (session.kicad as any).libraries={tables:async()=>[],addTableRow:async()=>{nativeWrites++;await writeFile(file,"(fp_lib_table)");}};
 await expect(f.sessions.preservingProjectLibraries(f.dir,session,async()=>{await writeFile(file,table("newer.pretty"));await (session.kicad as any).libraries.addTableRow("footprint","project",{},true);})).rejects.toThrow("recovery could not finish");
 expect(nativeWrites).toBe(0);expect(await readFile(file,"utf8")).toContain("newer.pretty");
 const {readdir}=await import("node:fs/promises"),dir=join(f.dir,".fabdesk/library-recovery"),names=await readdir(dir);const retained=await readFile(join(dir,names[0]!),"utf8");expect(retained).toContain("old.pretty");expect(retained).toContain("newer.pretty");
}));
