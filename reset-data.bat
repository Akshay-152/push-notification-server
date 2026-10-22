@echo off
setlocal EnableExtensions
title NotifyMe - Reset Data

rem ===========================================================================
rem  NotifyMe reset script
rem  - Stops the running server (node src/server.js) and frees port 3000
rem  - Backs up the current database, then wipes all subscriber/notification data
rem  - Clears temp logs
rem  - PRESERVES .env (your VAPID keys) - deleting it would orphan subscriptions
rem ===========================================================================

set "ROOT=%~dp0"
set "DB=%ROOT%data\app.sqlite"
set "BK=%ROOT%backups"
set "STAMP="
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%i"

echo.
echo ============================================
echo  NotifyMe data reset
echo ============================================
echo.

rem --- 1. Stop the server on port 3000 ---------------------------------------
echo [1/4] Stopping any server on port 3000 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r ":3000 .*LISTENING"') do (
    echo        port 3000 PID %%p
    taskkill /F /PID %%p >nul 2>&1
)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*src/server.js*' } | ForEach-Object { Write-Host ('        node src/server.js PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul
echo        done.

rem --- 2. Back up the existing database --------------------------------------
echo [2/4] Backing up current database ...
if not exist "%DB%" (
    echo        no existing database, skipping.
    goto wipe
)
if not exist "%BK%" mkdir "%BK%"
powershell -NoProfile -Command "$src='%DB%'; $dst='%BK%\app-%STAMP%.sqlite'; foreach($f in @('','-wal','-shm')){ $s=$src+$f; if(Test-Path $s){ Copy-Item $s ($dst+$f) -Force } }; if(Test-Path $dst){ Write-Host ('        backup -> ' + $dst) } else { Write-Host '        BACKUP FAILED - aborting wipe'; exit 1 }"
if errorlevel 1 (
    echo.
    echo  Backup failed. NOT wiping data. Check the message above.
    pause
    exit /b 1
)

:wipe
rem --- 3. Wipe database files (server must be stopped first) -----------------
echo [3/4] Removing database files ...
if exist "%DB%" del /f "%DB%"
if exist "%DB%-wal" del /f "%DB%-wal"
if exist "%DB%-shm" del /f "%DB%-shm"
echo        done.

rem --- 4. Clear temp logs ----------------------------------------------------
echo [4/4] Clearing temp logs ...
powershell -NoProfile -Command "Get-ChildItem $env:TEMP -Directory -Filter 'codebuff-process-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; Write-Host '        done.'"

echo.
echo ============================================
echo  Reset complete
echo ============================================
echo  Database wiped.  .env preserved (VAPID keys kept).
echo.
echo  Next steps:
echo    npm run migrate        ^> recreate the schema
echo    npm run create:admin   ^> recreate your admin login
echo    npm start              ^> run the server
echo.
echo  Then in Chrome: allow notifications for localhost:3000
echo  and click "Enable notifications" to create a fresh subscription.
echo.
pause
