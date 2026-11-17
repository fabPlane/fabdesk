import { expect, test } from "bun:test";
import { createRegistry, makeContext } from "../src";
import { mockServices, tempProject } from "./mock-services";

test("part discovery and compatibility receive the active project; registration is project-scoped", async () => {
  const project = await tempProject("local-libraries");
  const services = mockServices([project]);
  const calls: unknown[][] = [];
  services.design.searchFootprints = async (...args) => { calls.push(args); return []; };
  services.design.describePart = async (...args) => { calls.push(args); return { kind: args[0], libId: args[1], description: "local", pads: [] }; };
  services.design.registerLibrary = async (...args) => { calls.push(args); return { nickname: args[2], uri: "${KIPRJMOD}/" + args[3] }; };
  const registry = createRegistry();
  const invoke = (name: string, args: unknown) => registry.invoke(name, args, () => makeContext({ services, project }));
  await invoke("circuit_search_parts", { query: "Sensor" });
  await invoke("circuit_describe_part", { kind: "footprint", libId: "Pilot:Sensor" });
  const registered = await invoke("circuit_library", { action: "register", kind: "footprint", nickname: "Pilot", path: "Pilot.pretty" });
  expect(registered.json).toMatchObject({ nickname: "Pilot", uri: "${KIPRJMOD}/Pilot.pretty" });
  expect(calls).toEqual([["Sensor", 10, project.dir], ["footprint", "Pilot:Sensor", project.dir], [project.dir, "footprint", "Pilot", "Pilot.pretty"]]);
});
