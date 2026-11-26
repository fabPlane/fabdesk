[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('observe','click')][string]$Action,
    [Parameter(Mandatory)][int]$AppProcessId,
    [Parameter(Mandatory=$true)][ValidateSet('Update to 0.4.26','Restart now')][string]$Label
)
$ErrorActionPreference = 'Stop'
$expected = $env:FABDESK_TEST_INSTALLED_EXE
$app = Get-Process -Id $AppProcessId -ErrorAction Stop
if ($app.Path -ine $expected -or $app.MainWindowHandle -eq 0 -or $app.MainWindowTitle -ine 'fabPlane') {
    throw 'Selected PID is not the expected packaged FabDesk main window'
}
if ((Get-Item -LiteralPath $expected).VersionInfo.ProductVersion -notmatch '^0\.4\.24(?:\.0)?$') {
    throw 'Expected the installed 0.4.24 source build'
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FabNative {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int x, y; public P(int x,int y){this.x=x;this.y=y;} }
  [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public MouseInput mouse; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr awareness);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint f);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr w);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr w,int state);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n,Input[] a,int size);
  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint size, tick; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
  public static uint LastInputTick() { LastInput li = new LastInput(); li.size=8; if (!GetLastInputInfo(ref li)) throw new Exception("GetLastInputInfo failed"); return li.tick; }
  public static void UsePhysicalPixels(){ SetThreadDpiAwarenessContext(new IntPtr(-4)); }
  public static bool IsTargetAtPoint(IntPtr window,int x,int y) {
    return GetAncestor(WindowFromPoint(new P(x,y)),2) == window;
  }
  public static bool IsCursorAtPoint(int x,int y) {
    P p; return GetCursorPos(out p) && p.x == x && p.y == y;
  }
  public static uint LeftClick() {
    Input[] a = new Input[2]; a[0].mouse.flags = 2; a[1].mouse.flags = 4;
    return SendInput(2,a,Marshal.SizeOf(typeof(Input)));
  }
}
'@
[FabNative]::UsePhysicalPixels()
$hwnd=$app.MainWindowHandle
$ui=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
function Get-NativeControl([string]$name,[System.Windows.Automation.ControlType]$type) {
    $byName=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name)
    $byType=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$type)
    $filter=[System.Windows.Automation.AndCondition]::new($byName,$byType)
    $found=$ui.FindAll([System.Windows.Automation.TreeScope]::Descendants,$filter)
    if($found.Count -ne 1) {throw "Expected exactly one accessible '$name' control; found $($found.Count)"}
    $found.Item(0)
}
if ($Action -eq 'click') {
    if ([FabNative]::IsIconic($hwnd)) {[void][FabNative]::ShowWindowAsync($hwnd,9); Start-Sleep -Milliseconds 200}
    if ([FabNative]::GetForegroundWindow() -ne $hwnd) {
        [void][FabNative]::SetForegroundWindow($hwnd)
        Start-Sleep -Milliseconds 350
    }
    if ([FabNative]::GetForegroundWindow() -ne $hwnd) {throw 'FabDesk is not foreground; no input was sent'}
}
$button=Get-NativeControl $Label ([System.Windows.Automation.ControlType]::Button)
$rect=$button.Current.BoundingRectangle
if ($button.Current.IsOffscreen -or !$button.Current.IsEnabled -or $rect.Width -le 1 -or $rect.Height -le 1) {
    throw 'Update button is not visible and enabled'
}
$x=[int][Math]::Floor($rect.X+$rect.Width/2)
$y=[int][Math]::Floor($rect.Y+$rect.Height/2)
if ($Action -eq 'click') {
    if(![FabNative]::IsTargetAtPoint($hwnd,$x,$y)) {throw 'Update button is covered by another window'}
    if(![FabNative]::SetCursorPos($x,$y)) {throw 'Could not move pointer to Update'}
    Start-Sleep -Milliseconds 350
    $element=[System.Windows.Automation.AutomationElement]::FromPoint([Windows.Point]::new($x,$y))
    for($depth=0;$null -ne $element -and $depth -lt 12;$depth++) {
        if([System.Windows.Automation.Automation]::Compare($button,$element)) {break}
        $element=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($element)
    }
    if($null -eq $element -or $depth -eq 12) {throw 'Live accessibility hit-test disagrees with the observed Update button'}
    if([FabNative]::GetForegroundWindow() -ne $hwnd -or ![FabNative]::IsTargetAtPoint($hwnd,$x,$y) -or ![FabNative]::IsCursorAtPoint($x,$y)) {throw 'Pointer ownership changed; no click was sent'}
    $beforeTick=[FabNative]::LastInputTick()
    if([FabNative]::LeftClick() -ne 2){throw 'Unexpected SendInput result; inspect app before any retry'}
    Start-Sleep -Milliseconds 80
    $afterTick=[FabNative]::LastInputTick()
}
[pscustomobject]@{action=$Action;pid=$AppProcessId;window=$hwnd.ToInt64();label=$Label;x=$x;y=$y;width=$rect.Width;height=$rect.Height;foregroundImmediatelyBeforeClick=$true;inputBeforeClick=$beforeTick;inputAfterClick=$afterTick} | ConvertTo-Json -Compress
