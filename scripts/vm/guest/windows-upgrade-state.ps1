# Diagnostic snapshot of the installed app and staged NSIS executable. Never read
# daemon tokens, command lines, environment variables or unrelated process data.
param([string]$InstalledExe, [string]$Installer, [string]$ProfilePath)
$receipt = Get-Content -LiteralPath (Join-Path $ProfilePath "update-install.json") -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
$installed = Get-Item -LiteralPath $InstalledExe -ErrorAction SilentlyContinue
$cached = Get-Item -LiteralPath $Installer -ErrorAction SilentlyContinue
$names = @("fabplane*", "fabdesk*", "elevate", "Un_A", "Au_", [IO.Path]::GetFileNameWithoutExtension($Installer))
$related = Get-Process -Name $names -ErrorAction SilentlyContinue | Sort-Object Id -Unique
$shortcuts = @()
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in "DesktopDirectory", "CommonDesktopDirectory", "Programs", "CommonPrograms") {
  $link = Join-Path ([Environment]::GetFolderPath($folder)) "fabPlane.lnk"
  if ((Test-Path -LiteralPath $link) -and $shell.CreateShortcut($link).TargetPath -eq $InstalledExe) {
    $shortcuts += $folder
  }
}
[ordered]@{
  installedPath = $InstalledExe
  installedVersion = $installed.VersionInfo.ProductVersion
  receiptVersion = $receipt.version
  receiptPhase = $receipt.phase
  cachedInstaller = $Installer
  cachedBytes = $cached.Length
  shortcutsToInstalledExe = $shortcuts
  pcbSymbolsPresent = Test-Path -LiteralPath (Join-Path (Split-Path $InstalledExe) "resources\pcb\libraries\symbols")
  processes = @($related | ForEach-Object { @{ name = $_.ProcessName; pid = $_.Id } })
} | ConvertTo-Json -Compress -Depth 3
