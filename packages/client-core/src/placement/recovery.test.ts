import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  readPlacement,
  restorePlacement,
  DEVICE_PLACEMENT_RECOVERY,
  PLACEMENT_DRAFT_PATH,
} from "./index";
const board = readFileSync(new URL("./fixtures/usb-timer.kicad_pcb", import.meta.url), "utf8");
const saved = readPlacement(board, "saved-board.kicad_pcb");
const parse = async (text: string, name: string) => readPlacement(text, name);

test("corrupt recovery falls back to the saved project draft", async () => {
  const reads: string[] = [];
  const result = await restorePlacement({
    readRecovery: () => '{"schema":"broken"}',
    readFile: async (path) => {
      reads.push(path);
      return JSON.stringify(saved);
    },
    parse,
    paths: [PLACEMENT_DRAFT_PATH, "board.kicad_pcb"],
    signal: new AbortController().signal,
  });
  expect(result?.source).toBe(PLACEMENT_DRAFT_PATH);
  expect(result?.session.parts).toEqual(saved.parts);
  expect(result?.skipped).toEqual(["device recovery"]);
  expect(reads).toEqual([PLACEMENT_DRAFT_PATH]);
});
test("invalid recovery and corrupt saved draft fall back to the original without rewriting either", async () => {
  const copies = new Map([
      [PLACEMENT_DRAFT_PATH, '{"not":"a session"}'],
      ["board.kicad_pcb", board],
    ]),
    before = [...copies];
  const result = await restorePlacement({
    readRecovery: () => "{",
    readFile: async (path) => copies.get(path)!,
    parse,
    paths: [PLACEMENT_DRAFT_PATH, "board.kicad_pcb"],
    signal: new AbortController().signal,
  });
  expect(result?.source).toBe("board.kicad_pcb");
  expect(result?.session.parts).toHaveLength(12);
  expect(result?.skipped).toEqual(["device recovery", PLACEMENT_DRAFT_PATH]);
  expect([...copies]).toEqual(before);
});
test("valid device recovery takes precedence; storage access failure does not hide project files", async () => {
  const recovered = await restorePlacement({
    readRecovery: () => JSON.stringify(saved),
    readFile: async () => {
      throw Error("unexpected read");
    },
    parse,
    paths: [PLACEMENT_DRAFT_PATH],
    signal: new AbortController().signal,
  });
  expect(recovered?.source).toBe(DEVICE_PLACEMENT_RECOVERY);
  expect(recovered?.skipped).toEqual([]);
  const denied = await restorePlacement({
    readRecovery: () => {
      throw Error("storage unavailable");
    },
    readFile: async () => board,
    parse,
    paths: ["board.kicad_pcb"],
    signal: new AbortController().signal,
  });
  expect(denied?.source).toBe("board.kicad_pcb");
});
test("canceling recovery during read cannot open another source or apply stale state", async () => {
  const controller = new AbortController();
  let parses = 0;
  await expect(
    restorePlacement({
      readRecovery: () => null,
      readFile: async () => {
        controller.abort();
        return board;
      },
      parse: async (text, name) => {
        parses++;
        return parse(text, name);
      },
      paths: [PLACEMENT_DRAFT_PATH, "board.kicad_pcb"],
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(parses).toBe(0);
});
test("empty projects return no draft; exhausted recovery surfaces a useful error", async () => {
  expect(
    await restorePlacement({
      readRecovery: () => null,
      readFile: async () => board,
      parse,
      paths: [],
      signal: new AbortController().signal,
    }),
  ).toBeNull();
  await expect(
    restorePlacement({
      readRecovery: () => "{",
      readFile: async () => {
        throw Error("offline");
      },
      parse,
      paths: [PLACEMENT_DRAFT_PATH],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Choose a board or session using Open");
});
