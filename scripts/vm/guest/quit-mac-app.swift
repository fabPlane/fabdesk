import AppKit

// Send a normal AppKit quit to the exact process under test. Two mounted and
// installed copies can share a bundle identifier, making AppleScript's target ambiguous.
guard CommandLine.arguments.count == 3,
      let pid = Int32(CommandLine.arguments[1]),
      let app = NSRunningApplication(processIdentifier: pid),
      app.bundleIdentifier == "com.tensorfleet.fabdesk",
      let bundle = app.bundleURL?.resolvingSymlinksInPath(),
      bundle.path == URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath().path else {
    fatalError("The running process does not match the expected installed FabDesk app")
}
guard app.terminate() else {
    fatalError("AppKit declined the normal termination request for PID \(pid)")
}
print("AppKit requested normal quit of PID \(pid) at \(bundle.path)")
