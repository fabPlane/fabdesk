/** Load and save git-native `comments.json` / `NOTES.md`. */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BOARD_COMMENTS_FILE,
  BOARD_NOTES_FILE,
  BoardCommentsFile,
  CommentAnchor,
  CommentStatus,
  emptyBoardCommentsFile,
  type BoardComment,
  type CreateBoardComment,
  type PatchBoardComment,
} from "@fabdesk/protocol";
import { PROJECT_FILES, exists, jailPath, writeAtomic, writeJson } from "./fs";
import { ToolError, type ProjectHandle } from "./registry";

export async function commentsPath(project: ProjectHandle): Promise<string> {
  return jailPath(project.dir, PROJECT_FILES.comments);
}

export async function notesPath(project: ProjectHandle): Promise<string> {
  return jailPath(project.dir, PROJECT_FILES.notes);
}

export async function loadComments(project: ProjectHandle): Promise<BoardCommentsFile> {
  const path = await commentsPath(project);
  if (!(await exists(path))) return emptyBoardCommentsFile();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new ToolError(`${BOARD_COMMENTS_FILE} is not valid JSON`, "precondition");
  }
  const parsed = BoardCommentsFile.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError(
      `${BOARD_COMMENTS_FILE} does not match fabplane.board-comments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      "precondition",
    );
  }
  return parsed.data;
}

export async function saveComments(project: ProjectHandle, file: BoardCommentsFile): Promise<void> {
  await writeJson(await commentsPath(project), BoardCommentsFile.parse(file));
}

const commentLocks = new Map<string, Promise<unknown>>();

/**
 * Load, mutate and save `comments.json` under a per-file lock. HTTP routes and MCP tools share one
 * daemon process, so this serializes every writer; `writeAtomic` alone prevents torn JSON but not
 * lost updates.
 */
export async function updateComments<T>(
  project: ProjectHandle,
  mutate: (file: BoardCommentsFile) => { file: BoardCommentsFile; result: T } | Promise<{ file: BoardCommentsFile; result: T }>,
): Promise<T> {
  const key = await commentsPath(project);
  const prev = commentLocks.get(key) ?? Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(async () => {
      const { file, result } = await mutate(await loadComments(project));
      await saveComments(project, file);
      return result;
    });
  commentLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (commentLocks.get(key) === run) commentLocks.delete(key);
  }
}

export async function loadNotes(project: ProjectHandle): Promise<string> {
  const path = await notesPath(project);
  if (!(await exists(path))) return "";
  return readFile(path, "utf8");
}

export async function saveNotes(project: ProjectHandle, content: string): Promise<void> {
  if (content.length > 200_000) throw new ToolError(`${BOARD_NOTES_FILE} is too long`, "invalid_args");
  await writeAtomic(await notesPath(project), content);
}

export function newCommentId(): string {
  return `cmt_${randomBytes(6).toString("hex")}`;
}

export function createComment(
  file: BoardCommentsFile,
  input: CreateBoardComment,
  now = new Date().toISOString(),
): { file: BoardCommentsFile; comment: BoardComment } {
  if (file.comments.length >= 500) throw new ToolError("at most 500 pins per board", "precondition");
  const comment: BoardComment = {
    id: newCommentId(),
    createdAt: now,
    updatedAt: now,
    author: input.author ?? "local",
    status: "open",
    question: input.question,
    anchor: input.anchor,
  };
  return { file: { ...file, comments: [...file.comments, comment] }, comment };
}

export function patchComment(
  file: BoardCommentsFile,
  id: string,
  patch: PatchBoardComment,
  now = new Date().toISOString(),
): { file: BoardCommentsFile; comment: BoardComment } {
  const index = file.comments.findIndex((item) => item.id === id);
  if (index < 0) throw new ToolError(`comment not found: ${id}`, "not_found");
  const current = file.comments[index]!;
  const nextStatus: CommentStatus =
    patch.status ?? (patch.answer && current.status === "open" ? "answered" : current.status);
  const next: BoardComment = {
    ...current,
    updatedAt: now,
    status: nextStatus,
    ...(patch.question ? { question: patch.question } : {}),
    ...(patch.anchor ? { anchor: patch.anchor } : {}),
    ...(patch.threadId ? { threadId: patch.threadId } : {}),
    ...(patch.runId ? { runId: patch.runId } : {}),
    ...(patch.answer
      ? {
          answer: patch.answer,
          answeredAt: now,
          answeredBy: patch.answeredBy ?? current.answeredBy ?? "agent",
        }
      : {}),
    ...(!patch.answer && patch.answeredBy ? { answeredBy: patch.answeredBy } : {}),
  };
  const comments = file.comments.slice();
  comments[index] = next;
  return { file: { ...file, comments }, comment: next };
}

export function parseAnchorInput(input: {
  view: CommentAnchor["view"];
  x?: number;
  y?: number;
  xMm?: number;
  yMm?: number;
  ref?: string;
  pin?: string;
  pad?: string;
  net?: string;
  area?: CommentAnchor["area"];
}): CommentAnchor {
  const parsed = CommentAnchor.safeParse({
    view: input.view,
    ...(input.x !== undefined ? { x: input.x } : {}),
    ...(input.y !== undefined ? { y: input.y } : {}),
    ...(input.xMm !== undefined ? { xMm: input.xMm } : {}),
    ...(input.yMm !== undefined ? { yMm: input.yMm } : {}),
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.pin ? { pin: input.pin } : {}),
    ...(input.pad ? { pad: input.pad } : {}),
    ...(input.net ? { net: input.net } : {}),
    ...(input.area ? { area: input.area } : {}),
  });
  if (!parsed.success)
    throw new ToolError(parsed.error.issues.map((i) => i.message).join("; "), "invalid_args");
  return parsed.data;
}
