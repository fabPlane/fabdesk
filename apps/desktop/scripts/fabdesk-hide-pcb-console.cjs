// Loaded only by the bundled Windows PCB bridge. Its native session and router
// start these executables directly instead of using FabDesk's KiCad launcher.
const options = process.env.BUN_OPTIONS;
if (options) {
  const inherited = options.replace(/^"--preload=[^"]*\/fabdesk-hide-pcb-console\.cjs"(?: |$)/, "");
  if (inherited) process.env.BUN_OPTIONS = inherited;
  else delete process.env.BUN_OPTIONS;
}

const tools = new Set([process.env.KICAD_CLI, process.env.FP_PCB_JAVA].filter(Boolean));
Bun.spawn = new Proxy(Bun.spawn, {
  apply(spawn, receiver, args) {
    const [command, opts] = args;
    if (Array.isArray(command) && tools.has(command[0])) {
      return Reflect.apply(spawn, receiver, [command, { ...opts, windowsHide: true }]);
    }
    if (tools.has(command?.cmd?.[0])) {
      return Reflect.apply(spawn, receiver, [{ ...command, windowsHide: true }]);
    }
    return Reflect.apply(spawn, receiver, args);
  },
});
