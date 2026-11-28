import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { desktopProjectsDirectory, pinCustomProjectsDirectory } from "./desktop-projects";

test("the restarted desktop inherits the same absolute projects directory", () => {
  const env = { FABDESK_PROJECTS_DIR: "my boards//old/.././active/" };
  pinCustomProjectsDirectory(env);
  expect(env.FABDESK_PROJECTS_DIR).toBe(resolve("my boards", "active"));
  expect(desktopProjectsDirectory(env)).toBe(env.FABDESK_PROJECTS_DIR);
});

test("a default desktop keeps its projects directory selection automatic", () => {
  const env: NodeJS.ProcessEnv = {};
  pinCustomProjectsDirectory(env);
  expect(env.FABDESK_PROJECTS_DIR).toBeUndefined();
});
