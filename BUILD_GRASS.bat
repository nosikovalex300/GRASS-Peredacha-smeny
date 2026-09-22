@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul

echo ============================================
echo   GRASS - FINAL WINDOWS BUILD
 echo ============================================
echo.

set "NPM=C:\Program Files\nodejs\npm.cmd"
if not exist "%NPM%" set "NPM=%ProgramFiles(x86)%\nodejs\npm.cmd"
if not exist "%NPM%" (
  echo [ERROR] Node.js npm.cmd not found.
  pause
  exit /b 1
)

echo Using npm: %NPM%
echo.

if not exist "node_modules\electron\package.json" if not exist "node_modules\electron-updater\package.json" (
  echo [1/2] Installing dependencies...
  call "%NPM%" install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
) else (
  echo [1/2] Dependencies already installed.
)

echo.
echo [2/2] Building installer...
call "%NPM%" run dist:win
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   BUILD COMPLETED SUCCESSFULLY
echo ============================================
echo.
echo Installer is in: %CD%\dist\GRASS-Peredacha-smeny-Setup-*.exe
if exist "dist" start "" explorer "%CD%\dist"
pause
