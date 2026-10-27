@echo off
setlocal EnableExtensions
cd /d "%~dp0"

chcp 65001 >nul

title GRASS Release v1.7.11

echo ============================================================
echo GRASS - RELEASE v1.7.11
echo ============================================================
echo.
echo This script uploads the current project folder to GitHub.
echo GitHub Actions will build the Windows installer and publish Release v1.7.11.
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git was not found in PATH.
  echo Install Git for Windows and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo ERROR: package.json was not found.
  echo.
  pause
  exit /b 1
)

if not exist "shift-summary-icon.png" (
  echo ERROR: shift-summary-icon.png was not found.
  echo.
  pause
  exit /b 1
)
if not exist "styles.css" (
  echo ERROR: styles.css was not found.
  echo.
  pause
  exit /b 1
)
if not exist "shifts.js" (
  echo ERROR: shifts.js was not found.
  echo.
  pause
  exit /b 1
)
if not exist "img\background.webp" (
  echo ERROR: img folder was not found.
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if not errorlevel 1 (
  node -e "const p=require('./package.json'); if(p.version!=='1.7.11'){console.error('Wrong package version: '+p.version);process.exit(1)}"
  if errorlevel 1 (
    echo ERROR: package.json version must be 1.7.11.
    echo.
    pause
    exit /b 1
  )
  node --check main.js
  if errorlevel 1 (
    echo ERROR: main.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check preload.js
  if errorlevel 1 (
    echo ERROR: preload.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check shifts.js
  if errorlevel 1 (
    echo ERROR: shifts.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check stats.js
  if errorlevel 1 (
    echo ERROR: stats.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check reglament.js
  if errorlevel 1 (
    echo ERROR: reglament.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check journal.js
  if errorlevel 1 (
    echo ERROR: journal.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check comments.js
  if errorlevel 1 (
    echo ERROR: comments.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check export.js
  if errorlevel 1 (
    echo ERROR: export.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check ui-reglament.js
  if errorlevel 1 (
    echo ERROR: ui-reglament.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check ui-journal.js
  if errorlevel 1 (
    echo ERROR: ui-journal.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check ui-schedule.js
  if errorlevel 1 (
    echo ERROR: ui-schedule.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check ui-notify.js
  if errorlevel 1 (
    echo ERROR: ui-notify.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  node --check ui-export.js
  if errorlevel 1 (
    echo ERROR: ui-export.js syntax check failed.
    echo.
    pause
    exit /b 1
  )
  echo Running logic tests: shifts, statistics, reglament, journal, comments, export...
  call npm test
  if errorlevel 1 (
    echo ERROR: logic tests failed. Release stopped.
    echo.
    pause
    exit /b 1
  )
) else (
  echo WARNING: Node.js was not found locally. GitHub Actions will validate the project.
)

if not exist ".git\" (
  echo Creating local Git repository...
  git init
  if errorlevel 1 goto GIT_ERROR
)

git branch -M main
git config user.name "GRASS Release"
git config user.email "grass-release@users.noreply.github.com"

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin https://github.com/nosikovalex300/GRASS-Peredacha-smeny.git
) else (
  git remote set-url origin https://github.com/nosikovalex300/GRASS-Peredacha-smeny.git
)

echo.
echo Adding project files...
git add -A
if errorlevel 1 goto GIT_ERROR

git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Release v1.7.11"
  if errorlevel 1 goto GIT_ERROR
) else (
  echo No new local changes. Continuing.
)

echo.
echo Pushing main to GitHub...
git push -f origin HEAD:main
if errorlevel 1 goto PUSH_ERROR

echo.
echo Updating tag v1.7.11...
git tag -f v1.7.11 -m "GRASS Release v1.7.11"
if errorlevel 1 goto GIT_ERROR

git push -f origin v1.7.11
if errorlevel 1 goto PUSH_ERROR

echo.
echo ============================================================
echo RELEASE v1.7.11 HAS BEEN SENT TO GITHUB.
echo ============================================================
echo.
echo Actions:
echo https://github.com/nosikovalex300/GRASS-Peredacha-smeny/actions
echo.
echo Release:
echo https://github.com/nosikovalex300/GRASS-Peredacha-smeny/releases/tag/v1.7.11
echo.
echo The window will stay open. Press any key to close.
pause
exit /b 0

:GIT_ERROR
echo.
echo ERROR: Git command failed.
echo Check the message above.
echo.
pause
exit /b 1

:PUSH_ERROR
echo.
echo ERROR: Git push failed.
echo Check GitHub authentication and network access.
echo.
pause
exit /b 1
