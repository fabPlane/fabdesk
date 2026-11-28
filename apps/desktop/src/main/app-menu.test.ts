/** Menu commands must reach the main window, even when the Laser Controller window has focus. */
import { expect, mock, test } from "bun:test";

type FakeWindow = { name: string; sent: string[]; isDestroyed(): boolean; isMinimized(): boolean; restore(): void; focus(): void; webContents: { send(channel: string, command: string): void } };
const window = (name: string): FakeWindow => {
  const w: FakeWindow = {
    name, sent: [], isDestroyed: () => false, isMinimized: () => false, restore() {}, focus() {},
    webContents: { send: (_channel, command) => { w.sent.push(command); } },
  };
  return w;
};
const main = window("main");
const laser = window("laser");
let built: Array<{ label?: string; submenu?: Array<{ label?: string; click?: () => void }> }> = [];

mock.module("electron", () => ({
  app: { name: "fabPlane", getName: () => "fabPlane" },
  shell: { openExternal: () => undefined, openPath: () => undefined },
  Menu: { buildFromTemplate: (t: typeof built) => { built = t; return {}; }, setApplicationMenu: () => undefined },
  BrowserWindow: { getFocusedWindow: () => laser, getAllWindows: () => [laser, main] },
}));

test("with the Laser Controller focused, menu commands still go to the main window", async () => {
  const { installAppMenu, setMenuTarget } = await import("./app-menu");
  setMenuTarget(() => main as never);
  installAppMenu();
  const file = built.find(item => item.label === "File")!;
  file.submenu!.find(item => item.label === "Command palette…")!.click!();
  file.submenu!.find(item => item.label === "Laser Controller…")!.click!();
  expect(main.sent).toEqual(["palette", "laser-controller"]);
  expect(laser.sent).toEqual([]);
});
