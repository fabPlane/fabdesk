# Runs inside the Windows test VM, or directly on a fresh Windows CI runner.
#   VM:     started by the startup agent (see autounattend.xml) when it finds a payload drive with
#           fabdesk\windows-test.ps1; reads fabdesk\config.json ({installer, reportUrl}), uploads the
#           results to the host over HTTP and powers the VM off.
#   Runner: windows-test.ps1 -Installer <path> -Out <dir>  (no upload, no shutdown; report.json in -Out)
param([string]$Installer = "", [string]$Out = "")
$ErrorActionPreference = "Continue"
$payload = Split-Path -Parent $MyInvocation.MyCommand.Path
$reportUrl = ""
if ($Installer) {
  $installer = (Resolve-Path $Installer).Path
  $cfg = [pscustomobject]@{ installer = (Split-Path -Leaf $installer) }
} else {
  $cfg = Get-Content (Join-Path $payload "config.json") | ConvertFrom-Json
  $installer = Join-Path $payload $cfg.installer
  $reportUrl = $cfg.reportUrl
}
if (-not $Out) { $Out = Join-Path $env:TEMP "fabdesk-test" }
$out = $Out
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force $out | Out-Null
$log = Join-Path $out "log.txt"
$errors = @()
function Log($m) { $line = "$(Get-Date -Format HH:mm:ss) $m"; Write-Host $line; Add-Content $log $line }
function Err($m) { $script:errors += $m; Log "ERROR: $m" }
function Screenshot($path) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
    $bmp.Save($path); $g.Dispose(); $bmp.Dispose()
  } catch { Log "screen capture failed: $_" }
}
function Put($name, $path) {
  try { Invoke-RestMethod -Method Put -Uri "$reportUrl/$name" -InFile $path -ContentType "application/octet-stream" | Out-Null }
  catch { Log "upload of $name failed: $_" }
}

Log "== $((Get-CimInstance Win32_OperatingSystem).Caption) $env:PROCESSOR_ARCHITECTURE installer=$($cfg.installer)"
$ud = Join-Path $env:APPDATA "Fabdesk"
$udLegacy = Join-Path $env:APPDATA "@fabdesk\desktop"   # builds before 0.1.40
Remove-Item -Recurse -Force $ud, $udLegacy -ErrorAction SilentlyContinue | Out-Null
$install = ""; $exe = ""
# Simulate a browser download so SmartScreen metadata is present.
try { Set-Content -Path $installer -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3" } catch {}
$sig = Get-AuthenticodeSignature $installer
$codesign = "$($sig.Status) $($sig.SignerCertificate.Subject)"
Log "authenticode: $codesign"

if ($cfg.installer -match "Setup.*\.exe$" -or $cfg.installer -notmatch "portable") {
  # electron-builder's NSIS installer: /S installs silently, then launches the app (runAfterFinish),
  # so waiting for the installer's process tree never returns. Start it, then poll for the installed
  # app in the per-user and per-machine locations (an elevated session gets a per-machine install).
  $candidates = @((Join-Path $env:LOCALAPPDATA "Programs\Fabdesk\Fabdesk.exe"), (Join-Path $env:ProgramFiles "Fabdesk\Fabdesk.exe"))
  $motw = ""
  try { $p = Start-Process -FilePath $installer -ArgumentList "/S" -PassThru -ErrorAction Stop }
  catch {
    # Windows refused the downloaded (mark-of-the-web) file: what SmartScreen shows a user for an unsigned build.
    $motw = "blocked with mark-of-the-web ($($_.Exception.Message.Split([char]10)[0].Trim())); unblocked and retried"
    Log $motw
    Unblock-File $installer
    $p = Start-Process -FilePath $installer -ArgumentList "/S" -PassThru
  }
  $exe = ""
  for ($i = 0; $i -lt 180; $i++) {
    # The auto-launched instance tells us exactly where the installer put the app.
    $running = Get-Process -Name Fabdesk -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
    if ($running) { $exe = $running.Path; Log "installer launched $exe"; break }
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found -and $p.HasExited) { $exe = $found; break }
    Start-Sleep 1
  }
  if (-not $exe) {
    $found = Get-ChildItem -Path $env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)} -Filter Fabdesk.exe -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $exe = $found.FullName; Log "found installed app at $exe" }
  }
  if (-not $exe) {
    Screenshot (Join-Path $out "installer-hung.png")
    Get-Process | Where-Object { $_.Name -like "Fabdesk*" -or $_.Id -eq $p.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
    Err "NSIS silent install produced no Fabdesk.exe within 3 minutes (see installer-hung.png)"
  } else {
    Start-Sleep 3
    # The installer's auto-launched instance runs without the automation bridge: replace it with ours.
    if (Get-Process -Name Fabdesk -ErrorAction SilentlyContinue) { Log "installer auto-launched the app; stopping it for the instrumented launch"; Stop-Process -Name Fabdesk -Force -ErrorAction SilentlyContinue; Start-Sleep 2 }
    $install = "nsis /S -> $(Split-Path $exe)" + $(if ($motw) { "; $motw" } else { "" })
  }
} else {
  $exe = $installer
  $install = "portable exe"
}
if ($exe -and -not (Test-Path $exe)) { Err "no Fabdesk.exe at $exe after install" }

$core = if ($exe) { Join-Path (Split-Path $exe) "resources\core\fabdesk-core.exe" } else { "" }
if ($cfg.installer -match "portable") { $core = "" }
$coreVersion = ""
if ($core -and (Test-Path $core)) { $coreVersion = (& $core version 2>&1 | Select-Object -First 1); Log "core: $coreVersion" }
elseif ($core) { Err "core binary missing at $core" }

$health = ""; $shot = ""; $launchMs = ""
if ($exe -and (Test-Path $exe)) {
  $env:FABDESK_AUTOMATION = "1"; $env:FABDESK_UPDATE_CHECK = "0"
  $t0 = Get-Date
  $app = Start-Process -FilePath $exe -PassThru
  $daemon = Join-Path $ud "daemon.json"; $bridge = Join-Path $ud "app-bridge.json"
  for ($i = 0; $i -lt 90; $i++) {
    if (-not (Test-Path $daemon) -and (Test-Path (Join-Path $udLegacy "daemon.json"))) { $ud = $udLegacy; $daemon = Join-Path $ud "daemon.json"; $bridge = Join-Path $ud "app-bridge.json" }
    if ((Test-Path $daemon) -and (Test-Path $bridge)) { break }; Start-Sleep 1 }
  Log "userData: $ud"
  if (-not (Test-Path $daemon)) { Err "daemon.json never appeared (app did not start its core)" }
  else {
    $d = Get-Content $daemon | ConvertFrom-Json
    $hdr = @{ Authorization = "Bearer $($d.token)" }
    for ($i = 0; $i -lt 30; $i++) {
      try { $health = (Invoke-RestMethod -Headers $hdr -Uri "http://127.0.0.1:$($d.port)/health" | ConvertTo-Json -Compress); break } catch { Start-Sleep 1 }
    }
    if (-not $health) { Err "core /health did not answer on $($d.port)" }
    $launchMs = [int]((Get-Date) - $t0).TotalMilliseconds
    Start-Sleep 5
    if (Test-Path $bridge) {
      $b = Get-Content $bridge | ConvertFrom-Json
      try {
        $r = Invoke-RestMethod -Method Post -Headers $hdr -Uri "$($b.url)/screenshot" -ContentType "application/json" -Body '{"format":"png"}'
        [IO.File]::WriteAllBytes((Join-Path $out "app.png"), [Convert]::FromBase64String($r.base64))
        $shot = "app.png $($r.width) $($r.height)"
      } catch { Err "bridge screenshot failed: $_" }
    } else { Err "app-bridge.json missing" }
  }
  # Whole-screen capture (shows SmartScreen / installer dialogs if any).
  Screenshot (Join-Path $out "screen.png")
  Stop-Process -Name Fabdesk -Force -ErrorAction SilentlyContinue
  Get-ChildItem $ud -Filter *.log -ErrorAction SilentlyContinue | Copy-Item -Destination $out
}

$report = [ordered]@{ platform = "windows"; ok = ($errors.Count -eq 0); installer = $cfg.installer; install = $install
  codesign = $codesign; core_version = $coreVersion; health = $health; screenshot = $shot; launch_ms = $launchMs; errors = $errors }
$report | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $out "report.json")
if ($reportUrl) {
  Get-ChildItem $out | ForEach-Object { Put $_.Name $_.FullName }
  try { Invoke-RestMethod -Method Post -Uri "$reportUrl/__done" | Out-Null } catch {}
  Log "== done"
  Stop-Computer -Force
} else {
  Log "== done"
  if ($errors.Count -gt 0) { exit 1 }
}
