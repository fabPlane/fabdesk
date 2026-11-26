using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.AccessControl;
using System.Threading;

// GUI-subsystem helper, independent of the Electron job and installed directory.
internal static class UpdateLaunch {
    [StructLayout(LayoutKind.Sequential)]
    private struct LastInput { public uint Size, Tick; }
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput input);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(uint pid);
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedPointer, Stdin, Stdout, Stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string exe, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr env, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private static void LaunchInactive(string executable, string arguments, string cwd) {
        // STARTF_USESHOWWINDOW, SW_SHOWNOACTIVATE. Keep the caller's exact environment.
        var startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)), Flags = 1, Show = 4 };
        ProcessInfo info;
        if (!CreateProcessW(executable, new StringBuilder("\"" + executable + "\" " + arguments), IntPtr.Zero,
            IntPtr.Zero, false, 0, IntPtr.Zero, cwd, ref startup, out info))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        CloseHandle(info.Thread);
        CloseHandle(info.Process);
    }

    private static uint? InputTick() {
        var input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        return GetLastInputInfo(ref input) ? (uint?)input.Tick : null;
    }

    private static uint? CaptureForeground(int parent) {
        uint owner;
        var tick = InputTick();
        GetWindowThreadProcessId(GetForegroundWindow(), out owner);
        using (var self = Process.GetCurrentProcess()) {
            return tick.HasValue && owner == (uint)parent && AllowSetForegroundWindow((uint)self.Id) ? tick : null;
        }
    }

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

    private static void Launch(string executable, string workingDirectory, uint? foregroundTick = null, bool explicitRestart = false) {
        string arguments = Environment.GetEnvironmentVariable("FABDESK_NSIS_START_ARGS") ?? "";
        Environment.SetEnvironmentVariable("FABDESK_NSIS_START_ARGS", null);
        var launch = new ProcessStartInfo(executable, arguments) {
            UseShellExecute = false,
            WorkingDirectory = Directory.Exists(workingDirectory) ? workingDirectory : Path.GetDirectoryName(executable)
        };
        if (explicitRestart && (!foregroundTick.HasValue || InputTick() != foregroundTick)) {
            LaunchInactive(executable, arguments, launch.WorkingDirectory);
            return;
        }
        using (var child = Process.Start(launch)) {
            // Windows revokes this permission on subsequent user input. A user who
            // switched applications during installation keeps their foreground window.
            if (foregroundTick.HasValue && InputTick() == foregroundTick) {
                AllowSetForegroundWindow((uint)child.Id);
            }
        }
    }

    private static bool TargetInstalled(string executable, Version expected) {
        try {
            var v = FileVersionInfo.GetVersionInfo(executable);
            return v.ProductMajorPart == expected.Major && v.ProductMinorPart == expected.Minor && v.ProductBuildPart == expected.Build;
        } catch (IOException) { return false; } // NSIS may be between removing and extracting the EXE.
          catch (UnauthorizedAccessException) { return false; }
          catch (System.ComponentModel.Win32Exception) { return false; }
    }

    private static int Restart(string installer, string parentId, string executable, string cwd, string targetVersion, string arm = null) {
        var expected = new Version(targetVersion);
        var parentPid = Int32.Parse(parentId);
        uint? foregroundTick = null;
        if (arm != null) {
            foregroundTick = CaptureForeground(parentPid);
            File.WriteAllText(Path.Combine(arm, "ready"), "");
        }
        try {
            using (var parent = Process.GetProcessById(parentPid)) {
                if (arm != null) parent.WaitForExit();
                else if (!parent.WaitForExit(60000)) return 1;
            }
        } catch (ArgumentException) { /* The old Electron already exited. */ }
        if (arm != null) {
            bool committed = File.Exists(Path.Combine(arm, "commit"));
            try {
                File.Delete(Path.Combine(arm, "ready"));
                File.Delete(Path.Combine(arm, "commit"));
                Directory.Delete(arm);
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
            if (!committed) return 0;
        }
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < TimeSpan.FromMinutes(15)) {
            // An installer may appear after the parent exits. Its target PE can appear
            // well before the remaining resources are extracted and the mutex closes.
            if (TargetInstalled(executable, expected) && !Installing(installer)) {
                Launch(executable, cwd, foregroundTick, true);
                return 0;
            }
            Thread.Sleep(250);
        }
        return 1;
    }

    private static int Main(string[] args) {
        try {
            if (args.Length == 7 && args[0] == "arm")
                return Restart(args[1], args[2], args[3], args[4], args[5], args[6]);
            if (args.Length != 6) return 1;
            if (args[0] == "restart") return Restart(args[1], args[2], args[3], args[4], args[5]);
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
                Launch(args[4], args[5]);
            }
            return 0;
        } catch (Exception) { return 1; }
    }
}
