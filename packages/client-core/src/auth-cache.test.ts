import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AuthState } from "@fabdesk/protocol";
import { resetCloudAccountCache } from "./auth-cache";

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
