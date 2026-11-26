using System;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Threading;

// GUI-subsystem helper, independent of the Electron job and installed directory.
internal static class UpdateLaunch {
    private static bool Installing(string name) {
        try {
            Mutex installer;
            if (!Mutex.TryOpenExisting(name, MutexRights.Synchronize, out installer)) return false;
            installer.Dispose();
            return true;
        } catch (UnauthorizedAccessException) {
            // An elevated installation can own the named object with a stricter ACL.
            return true;
        }
    }

    private static int Main(string[] args) {
        if (args.Length != 6) return 1;
        try {
            if (!Installing(args[0])) return 0;
            bool first;
            using (var waiter = new Mutex(true, args[1], out first)) {
                Process parent;
                try { parent = Process.GetProcessById(Int32.Parse(args[2])); }
                catch (ArgumentException) { parent = null; }
                using (parent) {
                    File.WriteAllText(args[3] + ".tmp", "defer");
                    File.Move(args[3] + ".tmp", args[3]);
                    if (!first) return 0;
                    if (parent != null) parent.WaitForExit();
                }
                // Leave no handle to the installation mutex between checks.
                while (Installing(args[0])) Thread.Sleep(200);
                string arguments = Environment.GetEnvironmentVariable("FABDESK_NSIS_START_ARGS") ?? "";
                Environment.SetEnvironmentVariable("FABDESK_NSIS_START_ARGS", null);
                var launch = new ProcessStartInfo(args[4], arguments) {
                    UseShellExecute = false,
                    WorkingDirectory = Directory.Exists(args[5]) ? args[5] : Path.GetDirectoryName(args[4])
                };
                using (Process.Start(launch)) {}
            }
            return 0;
        } catch (Exception) { return 1; }
    }
}
