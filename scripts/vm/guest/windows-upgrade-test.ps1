# In-place update test on a fresh Windows CI runner: installs an older release with the NSIS
# installer, launches it with the automation bridge and the update check on, and lets
# upgrade-drive.py click "Update X" and "Restart to update" like a user. Passes when the app comes
# back on the version the site serves.
#   windows-upgrade-test.ps1 -Installer <older fabplane-*.exe> -Out <dir> [-Timeout seconds]
param([Parameter(Mandatory = $true)][string]$Installer, [Parameter(Mandatory = $true)][string]$Out, [int]$Timeout = 1200, [switch]$OneClick)
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force $Out | Out-Null
$log = Join-Path $Out "log.txt"
function Log($m) { $line = "$(Get-Date -Format HH:mm:ss) $m"; Write-Host $line; Add-Content $log $line }
function AppProcesses { Get-Process -Name fabplane, fabPlane -ErrorAction SilentlyContinue }
function IsApp($path) { $path -and (Test-Path (Join-Path (Split-Path $path) "resources\app.asar")) }

$installer = (Resolve-Path $Installer).Path
$ud = Join-Path $env:APPDATA "fabPlane"
if (Test-Path -LiteralPath $ud) { throw "Fresh FabDesk test profile required at $ud" }
Unblock-File $installer
Log "installing $(Split-Path -Leaf $installer)"
$p = Start-Process -FilePath $installer -ArgumentList "/S" -PassThru
$candidates = @((Join-Path $env:LOCALAPPDATA "Programs\fabPlane\fabplane.exe"), (Join-Path $env:ProgramFiles "fabPlane\fabplane.exe"))
$exe = ""
for ($i = 0; $i -lt 600; $i++) {
  $app = AppProcesses | Where-Object { IsApp $_.Path } | Select-Object -First 1
  if ($app) { $exe = $app.Path; break }
  $found = $candidates | Where-Object { IsApp $_ } | Select-Object -First 1
  if ($found -and $p.HasExited) { $exe = $found; break }
  Start-Sleep 1
}
if (-not $exe) { Log "ERROR: the NSIS install produced no app"; exit 1 }
Log "installed at $exe"
Start-Sleep 3
# The installer's auto-launched instance has no automation bridge: replace it with ours.
AppProcesses | Where-Object { IsApp $_.Path } | Stop-Process -Force -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 60; $i++) { if ($p.HasExited) { break }; Start-Sleep 1 }
Start-Sleep 3
Remove-Item -Force (Join-Path $ud "daemon.json"), (Join-Path $ud "app-bridge.json") -ErrorAction SilentlyContinue

$env:FABDESK_AUTOMATION = "1"
# The silent installer starts the updated app itself; a user-level variable reaches it either way.
[Environment]::SetEnvironmentVariable("FABDESK_AUTOMATION", "1", "User")
Remove-Item Env:FABDESK_UPDATE_CHECK -ErrorAction SilentlyContinue
$stdout = Join-Path $Out "native-stdout.txt"
$stderr = Join-Path $Out "native-stderr.txt"
Start-Process -FilePath $exe -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
$extra = @()
if ($OneClick) { $extra += '--one-click' }
python (Join-Path $PSScriptRoot "upgrade-drive.py") --user-data $ud --out $Out --timeout $Timeout --executable $exe @extra
$rc = $LASTEXITCODE
# Report only native installation milestones, never the complete process output.
$milestones = "Install on explicit quitAndInstall|Install: isSilent|Executing:|No update filepath provided|Could not run installer|Cannot run installer|could not install on exit"
foreach ($line in (Select-String -Path $stdout, $stderr -Pattern $milestones -ErrorAction SilentlyContinue)) {
  Log $line.Line
}
Get-ChildItem (Split-Path $exe) -ErrorAction SilentlyContinue | Select-Object Name, Length, LastWriteTime | Out-File (Join-Path $Out "install-dir.txt")
Get-ChildItem $ud -Include *.log, update-install.json -Recurse -Depth 0 -ErrorAction SilentlyContinue | Copy-Item -Destination $Out -ErrorAction SilentlyContinue
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save((Join-Path $Out "screen.png")); $g.Dispose(); $bmp.Dispose()
} catch { Log "screen capture failed: $_" }
Stop-Process -Name fabplane, fabPlane -Force -ErrorAction SilentlyContinue
exit $rc
