@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo ================================================
echo   GRASS — публикация версии v1.4.0 в GitHub
echo ================================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Git не найден в PATH.
  echo Установи Git for Windows и запусти этот файл снова.
  pause
  exit /b 1
)

if not exist package.json (
  echo [ERROR] package.json не найден. Запусти файл из корня проекта.
  pause
  exit /b 1
)

for /f "delims=" %%V in ('node -p "require('./package.json').version" 2^>nul') do set "VERSION=%%V"
if not "%VERSION%"=="1.4.0" (
  echo [ERROR] В package.json ожидается версия 1.4.0, сейчас: %VERSION%
  pause
  exit /b 1
)

if not exist .git\NUL (
  echo [1/6] Создаю локальный Git-репозиторий...
  git init
  if errorlevel 1 goto :error
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo [2/6] Добавляю GitHub remote...
  git remote add origin https://github.com/nosikovalex300/GRASS-Peredacha-smeny.git
) else (
  echo [2/6] GitHub remote уже настроен.
)

echo [3/6] Проверяю файлы проекта...
node --check main.js || goto :error
node --check preload.js || goto :error
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')" || goto :error

if not exist .gitignore (
  >.gitignore echo node_modules/
  >>.gitignore echo dist/
  >>.gitignore echo *.log
  >>.gitignore echo .DS_Store
)

echo [4/6] Создаю коммит v1.4.0...
git add .
git diff --cached --quiet
if not errorlevel 1 (
  echo Изменений для коммита нет.
) else (
  git commit -m "Release v1.4.0: updates and data recovery"
  if errorlevel 1 goto :error
)

git rev-parse "v1.4.0" >nul 2>&1
if errorlevel 1 (
  echo [5/6] Создаю тег v1.4.0...
  git tag -a v1.4.0 -m "GRASS — Передача смены v1.4.0"
  if errorlevel 1 goto :error
) else (
  echo [5/6] Тег v1.4.0 уже существует локально.
)

echo [6/6] Отправляю код и тег в GitHub...
git branch -M main
git push -u origin main
if errorlevel 1 goto :error
git push origin v1.4.0
if errorlevel 1 goto :error

echo.
echo ================================================
echo   ГОТОВО: v1.4.0 отправлена в GitHub.
echo   GitHub Actions должен собрать Windows installer.
echo ================================================
echo.
pause
exit /b 0

:error
echo.
echo ================================================
echo   ОШИБКА. Публикация остановлена.
echo ================================================
echo Проверь текст ошибки выше.
pause
exit /b 1
