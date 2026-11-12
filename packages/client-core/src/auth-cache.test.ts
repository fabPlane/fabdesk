import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AuthState } from "@fabdesk/protocol";
import { useAuthStore } from "./stores/auth";
import { acceptAuthSnapshot, hasFabplaneSession, cloudAccountId, resetCloudAccountCache } from "./auth-cache";

const signedIn = (subject: string): AuthState => ({ mode: "fabplane", status: "signed_in", principal: { subject } });

test("account changes clear cloud and sharing caches while retaining local project data", () => {
  const qc = new QueryClient();
  const privateKeys = [["cloud", "status"], ["cloud", "inventory", ""], ["project-share", "core", "local"], ["contributions", "core", "copy"], ["team-projects", "core"], ["team-boards", "core", "remote"]];
  for (const key of privateKeys) qc.setQueryData(key, { account: "owner" });
  qc.setQueryData(["project", "local"], { name: "Local design" });
  resetCloudAccountCache(qc, signedIn("owner"), signedIn("contributor"));
  for (const key of privateKeys) expect(qc.getQueryData(key)).toBeUndefined();
  expect(qc.getQueryData<{ name: string }>(["project", "local"])).toEqual({ name: "Local design" });
  qc.clear();
});

test("same-account refresh retains caches but sign-out drops them", () => {
  const qc = new QueryClient();
  qc.setQueryData(["cloud", "status"], { account: "owner" });
  resetCloudAccountCache(qc, signedIn("owner"), signedIn("owner"));
  expect(qc.getQueryData<{ account: string }>(["cloud", "status"])).toEqual({ account: "owner" });
  resetCloudAccountCache(qc, signedIn("owner"), { mode: "fabplane", status: "signed_out" });
  expect(qc.getQueryData(["cloud", "status"])).toBeUndefined();
  qc.clear();
});

test("an in-flight previous-account response cannot refill the cache after switching", async () => {
  const qc = new QueryClient();
  let finish!: (value: string) => void;
  const response = new Promise<string>((resolve) => { finish = resolve; });
  const pending = qc.fetchQuery({ queryKey: ["cloud", "status"], queryFn: () => response }).catch(() => undefined);
  resetCloudAccountCache(qc, signedIn("owner"), signedIn("contributor"));
  finish("old owner organizations");
  await pending;
  expect(qc.getQueryData(["cloud", "status"])).toBeUndefined();
  qc.clear();
});


test("cloud identity excludes local mode and non-authenticated states", () => {
  expect(cloudAccountId(signedIn("taylor"))).toBe("taylor");
  expect(cloudAccountId({ mode: "local", status: "signed_in", principal: { subject: "local" } })).toBeNull();
  expect(cloudAccountId({ mode: "fabplane", status: "error", principal: { subject: "old" } })).toBeNull();
  expect(cloudAccountId(null)).toBeNull();
});


test("a delayed login snapshot cannot replace a completed sign-in event", async () => {
  const qc = new QueryClient();
  const previous = useAuthStore.getState().state;
  const before: AuthState = { mode: "fabplane", status: "signed_out" };
  const pending: AuthState = { mode: "fabplane", status: "pending" };
  const current = signedIn("new-account");
  try {
    useAuthStore.getState().setState(before);
    qc.setQueryData(["auth"], before);
    let finish!: (value: AuthState) => void;
    const oldPoll = qc.fetchQuery({ queryKey: ["auth"], queryFn: () => new Promise<AuthState>(resolve => { finish = resolve; }) }).catch(() => undefined);
    useAuthStore.getState().setState(current);
    qc.setQueryData(["auth"], current);
    expect(acceptAuthSnapshot(qc, before, pending)).toBe(false);
    finish(pending);
    await oldPoll;
    expect(useAuthStore.getState().state).toBe(current);
    expect(qc.getQueryData<AuthState>(["auth"])).toEqual(current);
  } finally { qc.clear(); useAuthStore.setState({ state: previous }); }
});

test("an action snapshot still works without SSE", () => {
  const qc = new QueryClient();
  const previous = useAuthStore.getState().state;
  const before: AuthState = { mode: "fabplane", status: "signed_out" };
  const next = signedIn("new-account");
  try {
    useAuthStore.getState().setState(before);
    expect(acceptAuthSnapshot(qc, before, next)).toBe(true);
    expect(useAuthStore.getState().state).toBe(next);
    expect(qc.getQueryData<AuthState>(["auth"])).toEqual(next);
  } finally { qc.clear(); useAuthStore.setState({ state: previous }); }
});

test("an approved session without identity remains signed in but cannot reuse private account caches", () => {
  const unknown: AuthState = { mode: "fabplane", status: "signed_in", principal: { subject: "" } };
  expect(hasFabplaneSession(unknown)).toBe(true);
  expect(cloudAccountId(unknown)).toBe("");
  const qc = new QueryClient();
  qc.setQueryData(["cloud", "status", "core", ""], { private: true });
  resetCloudAccountCache(qc, unknown, { mode: "fabplane", status: "signed_out" });
  expect(qc.getQueryData(["cloud", "status", "core", ""])).toBeUndefined();
  qc.clear();
  expect(hasFabplaneSession({ mode: "local", status: "signed_in" })).toBe(false);
  expect(hasFabplaneSession({ mode: "fabplane", status: "pending" })).toBe(false);
});
