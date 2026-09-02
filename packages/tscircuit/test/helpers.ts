import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURES = join(import.meta.dir, "fixtures");

export async function loadFixtureCircuit(name = "led-usb"): Promise<unknown[]> {
  return (await Bun.file(join(FIXTURES, `${name}.circuit.json`)).json()) as unknown[];
}

/** Copies a fixture project into a fresh temp dir so builds never dirty the checkout. */
export async function tempProject(fixture: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-tscircuit-"));
  await cp(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}
