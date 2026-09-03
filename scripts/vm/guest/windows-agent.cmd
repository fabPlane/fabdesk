@echo off
rem Fabdesk installer-test startup agent. Installed into the auto-logon user's Startup folder by
rem autounattend.xml. On every boot it looks for a payload drive (scripts/vm/windows.sh attaches one as
rem a CD) carrying fabdesk\windows-test.ps1 and runs it; with no payload it does nothing.
timeout /t 15 /nobreak >nul
for %%d in (D E F G H I J) do (
  if exist %%d:\fabdesk\windows-test.ps1 (
    powershell -NoProfile -ExecutionPolicy Bypass -File %%d:\fabdesk\windows-test.ps1
    exit /b
  )
)
