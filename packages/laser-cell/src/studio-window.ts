/**
 * `studio-window` laser route: fabPlane operates ComMarker Studio's own window (Windows only).
 *
 * Studio has no API, but it is a Qt app whose widgets are visible to Windows UI Automation by their Qt object
 * names (checked on Studio 1.0.41 for the Omni X, 2026-11-27):
 *   ...ContentPanel.MarkMgrDlgLBS.widget_CmdButtonList.btnMark.pbtnMain   "Start(F2)"
 *   ...ContentPanel.MarkMgrDlgLBS.widget_CmdButtonList.btn_RedRight       "Preview"
 *   ...ContentPanel.DeviceStatus.DeviceStatusBg2.label_StateText          "Disconnected" / device state
 *   ...ContentPanel.DeviceStatus.DeviceStatusBg2.checkBox_DoorSensor      lid interlock on/off
 * fabPlane presses Start through UI Automation (no mouse or keyboard), and watches the Start button and the
 * state label to see the job run and finish. Studio must run at the same privilege level as fabPlane: started
 * normally it asks for administrator rights, and Windows then blocks other apps from pressing its buttons.
 *
 * NOT verified with a laser attached: which label/state Studio shows while marking is inferred (the Start
 * button changing or disabling). `completion: "timer"` falls back to the job time if that inference is wrong.
 */
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LaserDriver, LaserStatus } from "./cell";
import { LaserDriverError } from "./lasers";

export type StudioUiState = {
  /** Studio is running and has a main window. */
  running: boolean;
  /** Text of Studio's Start button, null when it cannot be seen (home page open, or Studio is elevated). */
  startLabel: string | null;
  startEnabled: boolean;
  /** Device state label, e.g. "Disconnected". */
  connection: string | null;
  /** Studio's "Door Sensor" (lid interlock) switch, null when not visible. */
  doorSensor: boolean | null;
  /** Names of other enabled buttons next to Start (Preview, Focus, Stop, ...). */
  buttons: string[];
  /** Titles of dialogs Studio has open on top of its main window. */
  dialogs: string[];
  /** Number of UI elements Windows could see; very few means Studio runs as administrator. */
  elements: number;
};

export type StudioPressTarget = "start" | "stop";

/** A job for Studio: vector file, its true size and place on the lens field, hatch and laser settings. */
export type StudioJobSpec = {
  /** Absolute path of an SVG/DXF Studio can import (export_laser_copper writes *.studio.svg). */
  file: string;
  /** True size of the shape; Studio scales imports to the lens field, so this is always set after import. */
  widthMm: number;
  heightMm: number;
  /** Shape centre on Studio's field (Studio's X / Y boxes; 0,0 = field centre). */
  xMm?: number;
  yMm?: number;
  fill?: { spacingMm: number; angleDeg: number; cross: boolean } | null;
  settings?: { powerPct?: number; speedMmPerS?: number; frequencyKhz?: number; pulse?: number; passes?: number };
};

export type StudioLoadResult = {
  ok: boolean;
  error?: string;
  /** Values Studio shows after fabPlane set them (strings as displayed). */
  values?: Record<string, unknown>;
  log: string[];
};

export type StudioUi = {
  read(): Promise<StudioUiState>;
  /** `cancelled` is checked right before the press runs (a Stop queued meanwhile cancels a Start). */
  press(target: StudioPressTarget, options?: { cancelled?: () => boolean }): Promise<{ ok: boolean; label?: string; error?: string }>;
  /** Stops a job load in progress when `signal` aborts. */
  load(spec: StudioJobSpec, signal?: AbortSignal): Promise<StudioLoadResult>;
  /** Cancels Start presses already running (their script checks right before clicking). */
  cancelPress?(): void;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new LaserDriverError("stopped"));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new LaserDriverError("stopped")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// ---------------------------------------------------------------- Windows UI Automation bridge

const STUDIO_UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$action = $env:FABPLANE_ACTION
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$S = [Windows.Automation.TreeScope]
function Send($o) { [Console]::Out.Write(($o | ConvertTo-Json -Compress -Depth 4)) }
$p = Get-Process ComMarker_Studio -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $p) { Send @{ running = $false }; exit }
# While a message box is open Windows reports it as the main window, so find Studio's editor window by its Qt name.
$wins = @($A::RootElement.FindAll($S::Children, (New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty, $p.Id))))
$central = New-Object Windows.Automation.PropertyCondition($A::AutomationIdProperty, 'MainWindow.centralWidget')
$main = $null
$dialogs = @()
foreach ($w in $wins) {
  if (-not $main -and $w.FindFirst($S::Descendants, $central)) { $main = $w; continue }
  $texts = @($w.FindAll($S::Descendants, (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Text))) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
  $dialogs += (@([string]$w.Current.Name) + $texts | Select-Object -First 3) -join ': '
}
if (-not $main) { $main = $A::FromHandle($p.MainWindowHandle) }
$all = @($main.FindAll($S::Descendants, [Windows.Automation.Condition]::TrueCondition))
function Pick($suffix) { foreach ($e in $all) { if ($e.Current.AutomationId.EndsWith($suffix)) { return $e } }; return $null }
$start = Pick 'widget_CmdButtonList.btnMark.pbtnMain'
$state = Pick 'DeviceStatusBg2.label_StateText'
$door = Pick 'DeviceStatusBg2.checkBox_DoorSensor'
$buttons = @()
foreach ($e in $all) { $c = $e.Current; if ($c.AutomationId -match 'widget_CmdButtonList\.' -and $c.ControlType -eq [Windows.Automation.ControlType]::Button -and $c.IsEnabled -and $c.Name) { $buttons += $c.Name } }
foreach ($e in $all) { if ($e.Current.ControlType -eq [Windows.Automation.ControlType]::Window) { $dialogs += [string]$e.Current.Name } }
if ($action -eq 'read') {
  $doorOn = $null
  if ($door) { try { $doorOn = ($door.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -eq 'On') } catch { } }
  Send @{
    running = $true
    startLabel = $(if ($start) { $start.Current.Name } else { $null })
    startEnabled = $(if ($start) { $start.Current.IsEnabled } else { $false })
    connection = $(if ($state) { $state.Current.Name } else { $null })
    doorSensor = $doorOn
    buttons = $buttons
    dialogs = $dialogs
    elements = $all.Count
  }
  exit
}
$target = $null
if ($action -eq 'start') { if ($start -and $start.Current.Name -match '^\s*Start') { $target = $start } }
else {
  if ($start -and $start.Current.Name -match 'Stop|Pause|Abort|Cancel') { $target = $start }
  else { foreach ($e in $all) { $c = $e.Current; if ($c.AutomationId -match 'widget_CmdButtonList\.' -and $c.ControlType -eq [Windows.Automation.ControlType]::Button -and $c.IsEnabled -and $c.Name -match '^\s*(Stop|Abort|Cancel)') { $target = $e; break } } }
}
if (-not $target) { Send @{ ok = $false; error = $(if ($start) { 'Studio shows "' + $start.Current.Name + '"' } else { 'Studio''s Start button is not visible' }) }; exit }
if (-not $target.Current.IsEnabled) { Send @{ ok = $false; error = '"' + $target.Current.Name + '" is greyed out in Studio' }; exit }
$label = $target.Current.Name
# Stop clicked while this script was finding the button: fabPlane created the cancel marker. Do not press.
if ($env:FABPLANE_CANCEL -and (Test-Path -LiteralPath $env:FABPLANE_CANCEL)) { Send @{ ok = $false; error = 'cancelled by Stop' }; exit }
# Invoke on its own runspace: if the button opens a modal dialog, Invoke would block until it closes.
$ps = [powershell]::Create()
[void]$ps.AddScript({ param($e) $e.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }).AddArgument($target)
$h = $ps.BeginInvoke()
[void]$h.AsyncWaitHandle.WaitOne(1500)
Send @{ ok = $true; label = $label }
[Console]::Out.Flush()
[Environment]::Exit(0)
`;

/**
 * Builds a job in Studio: new document, Vector import through the Windows file dialog, size and position
 * (Studio scales every import to the lens field), hatch fill, then the laser settings of the selected shape.
 * Custom Studio buttons (Vector, Fill) only react to mouse messages, so they get a posted click on Studio's
 * window (the real mouse does not move); line edits are committed with a posted Enter.
 */
const STUDIO_LOAD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FABPLANE_ARGS)) | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class FabW {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref P p);
  public static IntPtr FileDialog(uint pid) { IntPtr found = IntPtr.Zero; EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(64); GetClassName(h, c, 64); if (p == pid && c.ToString() == "#32770") { found = h; return false; } return true; }, IntPtr.Zero); return found; }
  public static void Click(IntPtr h, int sx, int sy) { var p = new P { X = sx, Y = sy }; ScreenToClient(h, ref p); var l = (IntPtr)((p.Y << 16) | (p.X & 0xFFFF)); PostMessage(h, 0x0200, IntPtr.Zero, l); PostMessage(h, 0x0201, (IntPtr)1, l); PostMessage(h, 0x0202, IntPtr.Zero, l); }
  public static void Enter(IntPtr h) { PostMessage(h, 0x0100, (IntPtr)0x0D, (IntPtr)0x001C0001); PostMessage(h, 0x0101, (IntPtr)0x0D, unchecked((IntPtr)(long)0xC01C0001)); }
}
'@
$A = [Windows.Automation.AutomationElement]
$S = [Windows.Automation.TreeScope]
$log = New-Object System.Collections.Generic.List[string]
# Exit hard: a background UI Automation call blocked by a modal dialog would otherwise keep PowerShell alive.
function Send($o) { [Console]::Out.Write(($o | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush(); [Environment]::Exit(0) }
# On failure, cancel a file dialog fabPlane opened so Studio is not left blocked.
$script:dialogOpened = $false
function Fail($msg) {
  if ($script:dialogOpened) { $d = [FabW]::FileDialog([uint32]$p.Id); if ($d -ne [IntPtr]::Zero) { [void][FabW]::PostMessage($d, 0x0111, [IntPtr]2, [IntPtr]::Zero) } }
  Send @{ ok = $false; error = $msg; log = $log }
}
$p = Get-Process ComMarker_Studio -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Fail 'ComMarker Studio is not open' }
function MainWin {
  $central = New-Object Windows.Automation.PropertyCondition($A::AutomationIdProperty, 'MainWindow.centralWidget')
  foreach ($w in $A::RootElement.FindAll($S::Children, (New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty, $p.Id)))) { if ($w.FindFirst($S::Descendants, $central)) { return $w } }
  return $null
}
$main = MainWin
if (-not $main) { Fail 'Studio main window not found' }
$hwnd = [IntPtr]$main.Current.NativeWindowHandle
# Studio rebuilds widgets while it works; UI Automation then fails now and again, so retry.
function Els {
  for ($i = 0; $i -lt 6; $i++) {
    try { return @($script:main.FindAll($S::Descendants, [Windows.Automation.Condition]::TrueCondition)) }
    catch { Start-Sleep -Milliseconds 400; $m = MainWin; if ($m) { $script:main = $m } }
  }
  return @($script:main.FindAll($S::Descendants, [Windows.Automation.Condition]::TrueCondition))
}
function Pick($suffix, $els) { if (-not $els) { $els = Els }; foreach ($e in $els) { if ($e.Current.AutomationId.EndsWith($suffix)) { return $e } }; return $null }
function WaitPick($suffix, $ms) { $t = [Diagnostics.Stopwatch]::StartNew(); while ($t.ElapsedMilliseconds -lt $ms) { $e = Pick $suffix; if ($e) { return $e }; Start-Sleep -Milliseconds 250 }; return $null }
function ClickEl($e) { $r = $e.Current.BoundingRectangle; [FabW]::Click($hwnd, [int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) }
function Val($e) { try { return $e.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { return $null } }
function SetField($suffix, $value, $label) {
  $e = Pick $suffix
  if (-not $e) { $log.Add("$label field not found"); return $null }
  if (-not $e.Current.IsEnabled) { $log.Add("$label is greyed out in Studio"); return $null }
  $e.SetFocus(); Start-Sleep -Milliseconds 150
  $e.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue([string]$value)
  [FabW]::Enter($hwnd); Start-Sleep -Milliseconds 350
  return Val (Pick $suffix)
}
function Items { for ($i = 0; $i -lt 4; $i++) { try { $l = Pick 'ObjListDock.widget_objlist.list_objList'; if (-not $l) { return 0 }; return @($l.FindAll($S::Descendants, (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem)))).Count } catch { Start-Sleep -Milliseconds 400 } }; return 0 }
# UI Automation Invoke on a button that opens a modal dialog blocks until the dialog closes: run it on its own runspace.
function InvokeAsync($automationId) {
  $ps = [powershell]::Create()
  [void]$ps.AddScript({
    param($procId, $id)
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $A = [Windows.Automation.AutomationElement]; $S = [Windows.Automation.TreeScope]
    $c = New-Object Windows.Automation.PropertyCondition($A::AutomationIdProperty, $id)
    foreach ($w in $A::RootElement.FindAll($S::Children, (New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty, $procId)))) {
      $e = $w.FindFirst($S::Descendants, $c); if ($e) { $e.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); break }
    }
  }).AddArgument($p.Id).AddArgument($automationId)
  return @{ ps = $ps; handle = $ps.BeginInvoke() }
}

# 1. a new, empty document
$homeBtn = Pick 'CHomePageDlg.widget_LeftPanel.pushButton_MainPage'
if ($homeBtn) { $homeBtn.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); $log.Add('created a document') }
elseif ((Items) -gt 0) {
  $add = Pick 'widget_right_more.btn_addNewDoc'
  if (-not $add) { Fail 'Studio has shapes in the open document and no New document button was found; close the document first' }
  $add.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); $log.Add('opened a new document tab')
}
$t = [Diagnostics.Stopwatch]::StartNew(); while ($t.ElapsedMilliseconds -lt 8000 -and ((-not (Pick 'DrawToolBar.dxf')) -or (Items) -gt 0)) { Start-Sleep -Milliseconds 300 }
if ((Items) -gt 0) { Fail 'could not get an empty document in Studio' }

# 2. Vector import through the Windows file dialog
$vec = WaitPick 'DrawToolBar.dxf' 5000
if (-not $vec) { Fail 'Studio''s Vector import button was not found' }
$importCall = InvokeAsync $vec.Current.AutomationId
$script:dialogOpened = $true
# The dialog window appears before its controls (slowly the first time after Studio starts): wait for the
# file name box itself.
$t = [Diagnostics.Stopwatch]::StartNew(); $dlg = [IntPtr]::Zero; $ed = [IntPtr]::Zero
while ($t.ElapsedMilliseconds -lt 30000 -and $ed -eq [IntPtr]::Zero) {
  Start-Sleep -Milliseconds 250
  $dlg = [FabW]::FileDialog([uint32]$p.Id)
  if ($dlg -ne [IntPtr]::Zero) { $cbx = [FabW]::FindWindowEx($dlg, [IntPtr]::Zero, 'ComboBoxEx32', $null); $cb = [FabW]::FindWindowEx($cbx, [IntPtr]::Zero, 'ComboBox', $null); $ed = [FabW]::FindWindowEx($cb, [IntPtr]::Zero, 'Edit', $null) }
}
if ($dlg -eq [IntPtr]::Zero) { Fail 'Studio did not open its file dialog for the Vector import' }
if ($ed -eq [IntPtr]::Zero) { Fail 'could not find the file name box in Studio''s file dialog' }
Start-Sleep -Milliseconds 300
[void][FabW]::SendMessage($ed, 0x000C, [IntPtr]::Zero, [string]$cfg.file)
[void][FabW]::PostMessage($dlg, 0x0111, [IntPtr]1, [IntPtr]::Zero)
$t = [Diagnostics.Stopwatch]::StartNew(); while ($t.ElapsedMilliseconds -lt 60000 -and (Items) -lt 1) { Start-Sleep -Milliseconds 300 }
if ((Items) -lt 1) { if ([FabW]::FileDialog([uint32]$p.Id) -ne [IntPtr]::Zero) { Fail 'Studio''s file dialog did not accept the job file' }; Fail 'the job did not appear in Studio after the import' }
$script:dialogOpened = $false
$log.Add("imported $($cfg.file)")
if ($importCall.handle.AsyncWaitHandle.WaitOne(5000)) { try { [void]$importCall.ps.EndInvoke($importCall.handle) } catch { }; $importCall.ps.Dispose() }

# 3. size and position (Studio scales imports to the lens field)
$out = @{}
if ($cfg.widthMm) {
  $out.width = SetField 'sizeWidget2.widget_3.ledtWidth' $cfg.widthMm 'Width'
  $h = Val (Pick 'sizeWidget2.widget_4.ledtHeight')
  if ($cfg.heightMm -and [math]::Abs([double]$h - [double]$cfg.heightMm) -gt 0.05) { $out.height = SetField 'sizeWidget2.widget_4.ledtHeight' $cfg.heightMm 'Height' } else { $out.height = $h }
}
if ($null -ne $cfg.xMm) { $out.x = SetField 'widget_5.ledtX' $cfg.xMm 'X' }
if ($null -ne $cfg.yMm) { $out.y = SetField 'widget_6.ledtY' $cfg.yMm 'Y' }

# 4. hatch fill
if ($cfg.fill) {
  $fillBtn = Pick 'TopEditTool.tbtnCheckFill'
  if (-not $fillBtn) { Fail 'Studio''s Fill button was not found' }
  ClickEl $fillBtn
  $dialog = WaitPick 'MainWindow.FillDialog' 6000
  if (-not $dialog) { Fail 'Studio did not open the Fill dialog' }
  function Toggle($suffix, $on) { $e = Pick $suffix; if (-not $e) { $log.Add("fill option $suffix not found"); return }; $tp = $e.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern); if (($tp.Current.ToggleState -eq 'On') -ne [bool]$on) { $tp.Toggle() } }
  function SetText($suffix, $v) { $e = Pick $suffix; if ($e) { $e.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue([string]$v) } else { $log.Add("fill field $suffix not found") } }
  Toggle 'FillWidget.group_fillEnable' $true
  Toggle 'group_fillEnable.widget_3.check_crossFill' ([bool]$cfg.fill.cross)
  SetText 'group_fillEnable.groupBox.edit_space' $cfg.fill.spacingMm
  SetText 'groupBox.widget_4.edit_angle' $cfg.fill.angleDeg
  $out.fill = @{ spacing = Val (Pick 'group_fillEnable.groupBox.edit_space'); angle = Val (Pick 'groupBox.widget_4.edit_angle') }
  (Pick 'FillDialog.widget_2.btn_ok').GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  $t = [Diagnostics.Stopwatch]::StartNew(); while ($t.ElapsedMilliseconds -lt 6000 -and (Pick 'MainWindow.FillDialog')) { Start-Sleep -Milliseconds 250 }
  $log.Add('hatch fill applied')
}

# 5. laser settings of the selected shape
$set = $cfg.settings
if ($set) {
  if ($null -ne $set.powerPct) {
    $pw = $null; foreach ($e in Els) { $id = $e.Current.AutomationId; if ($id -match 'MarkSet' -and $id -match 'Power' -and $e.Current.ControlType -eq [Windows.Automation.ControlType]::Edit) { $pw = $id; break } }
    if ($pw) { $out.power = SetField $pw $set.powerPct 'Power' } else { $log.Add('Studio shows no Power field for this laser; set power in Studio if it has one') }
  }
  if ($null -ne $set.speedMmPerS) { $out.speed = SetField 'horizontalLayout_Speed.labelDeep' $set.speedMmPerS 'Speed' }
  if ($null -ne $set.frequencyKhz) { $out.frequency = SetField 'horizontalLayout_Frequency.labelFrequency' $set.frequencyKhz 'Frequency' }
  if ($null -ne $set.pulse) { $out.pulse = SetField 'horizontalWidget_PWM.lineEdit_PW' $set.pulse 'Pulse width' }
  if ($null -ne $set.passes) { $out.passes = SetField 'horizontalLayout_Passes.editPassesNum' $set.passes 'Pass' }
  $iv = Pick 'horizontalWidget_LineSpacing.lineEdit_LineSpacing'
  if ($iv) { $out.interval = Val $iv }
}
$out.objects = Items
Send @{ ok = $true; values = $out; log = $log }
`;

/** Closes a Windows file dialog Studio has open (left behind when a load is stopped mid-import). */
const STUDIO_CANCEL_DIALOG_SCRIPT = String.raw`
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class FabC {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static int CancelDialogs(uint pid) { int n = 0; EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(64); GetClassName(h, c, 64); if (p == pid && c.ToString() == "#32770") { PostMessage(h, 0x0111, (IntPtr)2, IntPtr.Zero); n++; } return true; }, IntPtr.Zero); return n; }
}
'@
$n = 0
foreach ($p in @(Get-Process ComMarker_Studio -ErrorAction SilentlyContinue)) { $n += [FabC]::CancelDialogs([uint32]$p.Id) }
[Console]::Out.Write($n)
`;

export type PowerShellRunner = (script: string, timeoutMs: number, env?: Record<string, string>, signal?: AbortSignal) => Promise<string>;

const scriptFiles = new Map<string, string>();
/** Writes each script once to a temp .ps1 (scripts are too long for -EncodedCommand plus their inputs). */
function scriptFile(script: string): string {
  let path = scriptFiles.get(script);
  if (!path || !existsSync(path)) {
    const hash = createHash("sha1").update(script).digest("hex").slice(0, 12);
    path = join(tmpdir(), `fabplane-studio-${hash}.ps1`);
    writeFileSync(path, "\uFEFF" + script, "utf8");
    scriptFiles.set(script, path);
  }
  return path;
}

/** First error line of PowerShell's stderr, which non-interactive PowerShell writes as CLIXML. */
export function powerShellError(stderr: string): string {
  const text = stderr.startsWith("#< CLIXML")
    ? [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(m => m[1]!).join("")
        .replace(/_x000D_|_x000A_/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    : stderr;
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 300);
}

/** Script files blocked by a group policy: run the script inline instead (inputs stay in the environment). */
let scriptFilesBlocked = false;
const POLICY_ERROR = /execution polic|not digitally signed|running scripts is disabled/i;

export const runPowerShell: PowerShellRunner = async (script, timeoutMs, env = {}, signal) => {
  const attempt = async (inline: boolean) => {
    if (signal?.aborted) throw new LaserDriverError("stopped");
    const source = inline ? ["-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] : ["-File", scriptFile(script)];
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...source], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { out: out.trim(), err, code, timedOut };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
  let r = await attempt(scriptFilesBlocked);
  if (!scriptFilesBlocked && r.code !== 0 && POLICY_ERROR.test(r.err)) {
    scriptFilesBlocked = true;
    r = await attempt(true);
  }
  if (signal?.aborted) throw new LaserDriverError("stopped");
  if (r.timedOut) throw new LaserDriverError(`ComMarker Studio did not respond within ${Math.round(timeoutMs / 1000)} s; check Studio for an open dialog`);
  if (r.code !== 0 || !r.out) throw new LaserDriverError(`could not read ComMarker Studio's window (${powerShellError(r.err) || `exit ${r.code}`})`);
  return r.out;
};

/** UI Automation bridge to a running ComMarker Studio (Windows). */
export function windowsStudioUi(run: PowerShellRunner = runPowerShell): StudioUi {
  if (process.platform !== "win32") {
    const unsupported = async (): Promise<never> => { throw new LaserDriverError("Controlling the ComMarker Studio window needs Windows"); };
    return { read: unsupported, press: unsupported, load: unsupported, cancelPress: () => undefined };
  }
  let queue: Promise<unknown> = Promise.resolve();
  const once = <T>(action: string, env: Record<string, string> = {}) => run(STUDIO_UIA_SCRIPT, 20_000, { FABPLANE_ACTION: action, ...env }).then(out => JSON.parse(out) as T);
  /** Cancel-marker files of Start presses in flight; Stop creates them, the script checks right before clicking. */
  const inflight = new Set<string>();
  const call = <T>(action: string, cancelled?: () => boolean): Promise<T> => {
    const go = async () => {
      if (cancelled?.()) return { ok: false, error: "cancelled by Stop" } as T;
      if (action !== "start") return once<T>(action);
      const marker = join(tmpdir(), `fabplane-cancel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      inflight.add(marker);
      try {
        if (cancelled?.()) return { ok: false, error: "cancelled by Stop" } as T;
        return await once<T>(action, { FABPLANE_CANCEL: marker });
      } finally {
        inflight.delete(marker);
        rmSync(marker, { force: true });
      }
    };
    const next = queue.then(go, go);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    async read() {
      const raw = await call<Partial<StudioUiState>>("read");
      return {
        running: raw.running === true,
        startLabel: raw.startLabel ?? null,
        startEnabled: raw.startEnabled === true,
        connection: raw.connection ?? null,
        doorSensor: raw.doorSensor ?? null,
        buttons: Array.isArray(raw.buttons) ? raw.buttons : raw.buttons ? [String(raw.buttons)] : [],
        dialogs: (Array.isArray(raw.dialogs) ? raw.dialogs : raw.dialogs ? [String(raw.dialogs)] : []).filter(name => name !== ""),
        elements: raw.elements ?? 0,
      };
    },
    // Stop runs at once, in its own PowerShell, instead of waiting behind a read or a load.
    press: (target, options) => (target === "stop" ? once(target) : call(target, options?.cancelled)),
    cancelPress() {
      for (const marker of inflight) { try { writeFileSync(marker, "stop"); } catch { /* already finished */ } }
    },
    async load(spec, signal) {
      const args = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
      const go = async () => {
        try {
          return JSON.parse(await run(STUDIO_LOAD_SCRIPT, 300_000, { FABPLANE_ARGS: args }, signal)) as StudioLoadResult;
        } catch (error) {
          // Stopped mid-import: close the file dialog the killed script may have left open in Studio.
          if (signal?.aborted) await run(STUDIO_CANCEL_DIALOG_SCRIPT, 15_000).catch(() => undefined);
          throw error;
        }
      };
      const next = queue.then(go, go);
      queue = next.catch(() => undefined);
      const result = await next;
      return { ...result, log: Array.isArray(result.log) ? result.log : result.log ? [String(result.log)] : [] };
    },
  };
}

// ---------------------------------------------------------------- driver

export type StudioWindowOptions = {
  /** watch = follow Studio's Start button; timer = wait `markSeconds + marginSeconds` (fallback). */
  completion: "watch" | "timer";
  markSeconds: number;
  marginSeconds: number;
  pollMs?: number;
  /** How long Studio may take to show the job as running after Start. */
  startTimeoutMs?: number;
};

/** Fields whose value in Studio differs from what fabPlane asked for (Studio may round or clamp). */
export function studioMismatches(spec: StudioJobSpec, values: Record<string, unknown>): string[] {
  const want: Array<[string, number | undefined]> = [
    ["width", spec.widthMm], ["height", spec.heightMm], ["x", spec.xMm], ["y", spec.yMm],
    ["speed", spec.settings?.speedMmPerS], ["frequency", spec.settings?.frequencyKhz], ["pulse", spec.settings?.pulse],
    ["passes", spec.settings?.passes], ["power", spec.settings?.powerPct],
  ];
  const out: string[] = [];
  for (const [key, expected] of want) {
    if (expected === undefined || !(key in values)) continue;
    const shown = Number.parseFloat(String(values[key] ?? ""));
    if (!Number.isFinite(shown) || Math.abs(shown - expected) > Math.max(0.011, Math.abs(expected) * 0.005)) out.push(`${key} is ${values[key] ?? "empty"} (wanted ${expected})`);
  }
  return out;
}

const isStartLabel = (label: string | null) => label !== null && /^\s*Start/i.test(label);

/** Studio shows an enabled Stop/Pause/Abort/Cancel button next to Start: a job is running. */
const stopShown = (state: StudioUiState) => state.buttons.some(b => /^\s*(Stop|Pause|Abort|Cancel)\b/i.test(b));

export function studioBusy(state: StudioUiState): boolean {
  return stopShown(state) || (state.startLabel !== null && !(isStartLabel(state.startLabel) && state.startEnabled));
}

/**
 * Positive evidence that Studio is idle: an enabled "Start" button in a fully readable window. A missing
 * button or a partly read window (Studio rebuilding its panel) is unknown, never "finished".
 */
export function studioIdle(state: StudioUiState): boolean {
  return state.running && state.elements >= 10 && isStartLabel(state.startLabel) && state.startEnabled && state.dialogs.length === 0 && !stopShown(state);
}

export class StudioWindowLaser implements LaserDriver {
  readonly name = "ComMarker Studio (window control)";
  /** Labels Studio showed while marking, for the log (the busy state is inferred, see the file header). */
  readonly seenBusyLabels = new Set<string>();
  /** Bumped by stop(); a start that sees a different value does not press Start. */
  private generation = 0;
  /** The Start press in flight, so stop() can wait for it and stop what it started. */
  private startPress: Promise<{ ok: boolean }> | null = null;

  constructor(readonly ui: StudioUi, private readonly options: StudioWindowOptions) {}

  /** In timer mode fabPlane waits the job time; checked against the time limit before the start. */
  get expectedSeconds(): number | undefined {
    return this.options.completion === "timer" ? this.options.markSeconds + this.options.marginSeconds : undefined;
  }

  async status(): Promise<LaserStatus> {
    const s = await this.ui.read();
    if (!s.running) return { state: "offline", detail: "ComMarker Studio is not open; start it with the fabPlane shortcut and open the job", driver: this.name };
    if (s.dialogs.length) return { state: "error", detail: `Studio has a dialog open (${s.dialogs.join(", ") || "untitled"}); close it`, driver: this.name };
    if (s.startLabel === null) {
      return {
        state: "error",
        detail: s.elements < 10
          ? "fabPlane cannot see inside Studio's window; Studio is probably running as administrator. Close it and start it with the \"ComMarker Studio (fabPlane)\" shortcut"
          : "Studio's Start button is not visible; open the job (not Studio's home page)",
        driver: this.name,
      };
    }
    if (s.connection && /disconnect|offline|not connected/i.test(s.connection)) {
      return { state: "offline", detail: `Studio shows the laser as "${s.connection}"; connect the Omni X in Studio`, driver: this.name };
    }
    const door = s.doorSensor === null ? "" : `, door sensor ${s.doorSensor ? "on" : "off"}`;
    if (studioBusy(s)) return { state: "busy", detail: `Studio is busy (button "${s.startLabel}"${s.startEnabled ? "" : ", greyed out"}, state "${s.connection ?? "?"}")`, driver: this.name };
    return { state: "idle", detail: `ready: Studio shows "${s.connection ?? "?"}"${door}`, driver: this.name };
  }

  async start(): Promise<void> {
    const generation = this.generation;
    const status = await this.status();
    if (generation !== this.generation) throw new LaserDriverError("stopped");
    if (status.state !== "idle") throw new LaserDriverError(`Studio is not ready to start: ${status.detail}`, true);
    this.startPress = this.ui.press("start", { cancelled: () => generation !== this.generation });
    let result: { ok: boolean; error?: string };
    try {
      result = await this.startPress;
    } finally {
      this.startPress = null;
    }
    if (generation !== this.generation) throw new LaserDriverError("stopped");
    // ok:false always means Start was not clicked (the script checks everything before clicking).
    if (!result.ok) throw new LaserDriverError(`could not press Start in Studio: ${result.error ?? "unknown"}`, true);
  }

  async waitDone({ timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
    const poll = this.options.pollMs ?? 1500;
    const started = Date.now();
    if (this.options.completion === "timer") {
      await sleep((this.options.markSeconds + this.options.marginSeconds) * 1000, signal);
      // Still check Studio did finish before the arm goes in.
      for (;;) {
        const s = await this.ui.read();
        if (s.dialogs.length) throw new LaserDriverError(`Studio opened a dialog while marking (${s.dialogs.join(", ")})`);
        if (studioIdle(s)) return;
        if (Date.now() - started > timeoutMs) throw new LaserDriverError(`job still running after ${Math.round(timeoutMs / 1000)} s`);
        await sleep(poll, signal);
      }
    }
    let seenBusy = false;
    let idleStreak = 0;
    for (;;) {
      if (signal?.aborted) throw new LaserDriverError("stopped");
      const s = await this.ui.read();
      if (!s.running) throw new LaserDriverError("ComMarker Studio closed while marking");
      if (s.dialogs.length) throw new LaserDriverError(`Studio opened a dialog while marking (${s.dialogs.join(", ")}); check the laser`);
      if (s.connection && /disconnect/i.test(s.connection)) throw new LaserDriverError("Studio lost the laser connection while marking");
      if (studioIdle(s)) idleStreak++;
      else {
        if (studioBusy(s)) { seenBusy = true; this.seenBusyLabels.add(`${s.startLabel} / ${s.connection ?? "?"}`); }
        idleStreak = 0; // busy, or unknown (button missing, window partly read): never counted as finished
      }
      if (seenBusy && idleStreak >= 2) return;
      if (!seenBusy && Date.now() - started > (this.options.startTimeoutMs ?? 10_000)) {
        throw new LaserDriverError("Studio's Start button never changed after fabPlane pressed it, so fabPlane cannot tell when the job ends. Check that Start runs the job in Studio, or set Completion to \"Job time\"");
      }
      if (Date.now() - started > timeoutMs) throw new LaserDriverError(`job still running after ${Math.round(timeoutMs / 1000)} s`);
      await sleep(poll, signal);
    }
  }

  /**
   * Builds the job in Studio (new document, import, size/position, fill, settings) and checks what Studio
   * shows afterwards. Refuses while Studio is busy marking.
   */
  async loadJob(spec: StudioJobSpec, signal?: AbortSignal): Promise<StudioLoadResult> {
    const before = await this.ui.read();
    if (!before.running) throw new LaserDriverError("ComMarker Studio is not open; start it with the \"ComMarker Studio (fabPlane)\" shortcut");
    if (studioBusy(before)) throw new LaserDriverError("Studio is busy; wait until the job has finished");
    if (before.dialogs.length) throw new LaserDriverError(`Studio has a dialog open (${before.dialogs.join(", ")}); close it first`);
    // Studio's size and position boxes take two decimals and silently ignore longer values.
    const mm = (v: number) => Math.round(v * 100) / 100;
    spec = {
      ...spec,
      widthMm: mm(spec.widthMm),
      heightMm: mm(spec.heightMm),
      ...(spec.xMm !== undefined ? { xMm: mm(spec.xMm) } : {}),
      ...(spec.yMm !== undefined ? { yMm: mm(spec.yMm) } : {}),
    };
    const result = await this.ui.load(spec, signal);
    if (!result.ok) throw new LaserDriverError(`could not load the job into Studio: ${result.error ?? "unknown error"}`);
    const mismatches = studioMismatches(spec, result.values ?? {});
    if (mismatches.length) result.log.push(`check in Studio: ${mismatches.join("; ")}`);
    return result;
  }

  /** Presses Studio's Stop button if it shows one. Not a safety stop: keep the Omni X E-stop within reach. */
  async stop(): Promise<void> {
    this.generation++;
    this.ui.cancelPress?.();
    const inflight = this.startPress;
    const first = this.ui.press("stop").catch(() => undefined);
    // A Start that was clicked before the cancel reached it: press Stop again once Studio shows its Stop.
    const started = inflight ? await inflight.then(r => r.ok, () => false) : false;
    await first;
    for (let i = 0; started && i < 4; i++) {
      const r = await this.ui.press("stop").catch(() => ({ ok: false }));
      if (r.ok) break;
      await sleep(600);
    }
  }
}

// ---------------------------------------------------------------- launching Studio

export const DEFAULT_STUDIO_EXE = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "ComMarker_Studio", "ComMarker_Studio.exe");

/**
 * Starts ComMarker Studio without administrator rights (`__COMPAT_LAYER=RunAsInvoker`) so fabPlane may press
 * its buttons, and waits for its window. Does nothing when Studio is already running.
 */
export async function launchStudio(ui: StudioUi, exe = DEFAULT_STUDIO_EXE, timeoutMs = 45_000): Promise<"running" | "started"> {
  if ((await ui.read()).running) return "running";
  if (process.platform !== "win32") throw new LaserDriverError("ComMarker Studio needs Windows");
  if (!(await Bun.file(exe).exists())) throw new LaserDriverError(`ComMarker Studio was not found at ${exe}; install it or set its path`);
  const dir = dirname(exe);
  Bun.spawn(["cmd.exe", "/c", "start", "", exe], { cwd: dir, env: { ...process.env, __COMPAT_LAYER: "RunAsInvoker" }, stdout: "ignore", stderr: "ignore", windowsHide: true });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(1500);
    const s = await ui.read().catch(() => null);
    if (s?.running && s.elements >= 10) return "started";
  }
  throw new LaserDriverError("ComMarker Studio did not open its window in time");
}
