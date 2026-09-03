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
  $dir = Join-Path $env:LOCALAPPDATA "Programs\Fabdesk"
  $p = Start-Process -FilePath $installer -ArgumentList "/S" -PassThru -Wait
  if ($p.ExitCode -ne 0) { Err "NSIS silent install exited $($p.ExitCode)" }
  $exe = Join-Path $dir "Fabdesk.exe"
  $install = "nsis /S exit $($p.ExitCode) -> $dir"
} else {
  $exe = $installer
  $install = "portable exe"
}
if (-not (Test-Path $exe)) { Err "no Fabdesk.exe at $exe after install" }

$core = Join-Path (Split-Path $exe) "resources\core\fabdesk-core.exe"
if ($cfg.installer -match "portable") { $core = "" }
$coreVersion = ""
if ($core -and (Test-Path $core)) { $coreVersion = (& $core version 2>&1 | Select-Object -First 1); Log "core: $coreVersion" }
elseif ($core) { Err "core binary missing at $core" }

$health = ""; $shot = ""; $launchMs = ""
if (Test-Path $exe) {
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
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
    $bmp.Save((Join-Path $out "screen.png")); $g.Dispose(); $bmp.Dispose()
  } catch { Log "screen capture failed: $_" }
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
