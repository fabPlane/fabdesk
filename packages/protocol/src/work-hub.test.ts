import { expect, test } from "bun:test";
import { gitHubRepoFromRemote, hardwareSignals, PublishProject, suggestRepoName, UpdateWorkConnection } from "./work-hub";

test("hardware detection reads design files, folders, languages and topics, and ignores software repositories", () => {
  expect(hardwareSignals({ languages: ["TypeScript"], topics: ["web"], rootEntries: [{ name: "src", directory: true }, { name: "board.ts", directory: false }] })).toEqual([]);
  expect(hardwareSignals({ languages: [], topics: [], rootEntries: [{ name: "fabdesk.json", directory: false }, { name: "main.kicad_pcb", directory: false }] })).toEqual(["fabPlane project", "main.kicad_pcb"]);
  expect(hardwareSignals({ languages: ["KiCad Layout", "Python"], topics: ["Open-Hardware"], rootEntries: [{ name: "hardware", directory: true }, { name: "hardware.md", directory: false }] })).toEqual(["hardware/", "KiCad Layout", "#Open-Hardware"]);
  // A file named like a hardware folder is not a signal, and the list stays short.
  expect(hardwareSignals({ languages: [], topics: [], rootEntries: [{ name: "pcb", directory: false }] })).toEqual([]);
  expect(hardwareSignals({ languages: [], topics: [], rootEntries: Array.from({ length: 20 }, (_, index) => ({ name: `part${index}.step`, directory: false })) })).toHaveLength(6);
});

test("GitHub remotes are recognised in https and ssh form; other hosts and credentials in paths are not", () => {
  expect(gitHubRepoFromRemote("https://github.com/fabPlane/fabdesk.git\n")).toEqual({ fullName: "fabPlane/fabdesk", url: "https://github.com/fabPlane/fabdesk" });
  expect(gitHubRepoFromRemote("git@github.com:fabPlane/fab_pcb.git")?.fullName).toBe("fabPlane/fab_pcb");
  expect(gitHubRepoFromRemote("https://x-access-token@github.com/a/b")?.url).toBe("https://github.com/a/b");
  expect(gitHubRepoFromRemote("https://gitlab.com/a/b.git")).toBeNull();
  expect(gitHubRepoFromRemote("https://github.com.evil.example/a/b")).toBeNull();
  expect(gitHubRepoFromRemote("/tmp/bare.git")).toBeNull();
});

test("repository names are suggested from project names and inputs are validated", () => {
  expect(suggestRepoName("USB-C Power Board (rev 2)")).toBe("USB-C-Power-Board-rev-2");
  expect(suggestRepoName("  …  ")).toBe("project");
  expect(PublishProject.parse({ owner: "fabPlane", name: "blinky" })).toEqual({ owner: "fabPlane", name: "blinky", private: true });
  expect(PublishProject.safeParse({ owner: "fabPlane", name: "a/b" }).success).toBe(false);
  expect(PublishProject.safeParse({ owner: "-bad", name: "ok" }).success).toBe(false);
  expect(UpdateWorkConnection.safeParse({ token: "ghp_short" }).success).toBe(false);
  expect(UpdateWorkConnection.safeParse({ token: "ghp_abcdefghijklmnopqrstuvwxyz\nX-Injected: 1" }).success).toBe(false);
});
