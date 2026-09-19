GRASS — автоматическая сборка Windows EXE через GitHub Actions

Что это даёт
------------
После настройки GitHub репозитория Windows-сборка выполняется на сервере GitHub.
На компьютере сотрудника Node.js, npm, Git и исходники проекта НЕ нужны.

Workflow
--------
.github/workflows/build-windows.yml

Запуск сборки
-------------
1. GitHub -> репозиторий GRASS -> вкладка Actions.
2. Выбрать "Build GRASS for Windows".
3. Нажать "Run workflow".
4. После завершения открыть job и скачать Artifact:
   GRASS-Windows-Installer-<номер запуска>.
5. Внутри будет:
   GRASS-Peredacha-smeny-Setup-1.3.0.exe
   SHA256SUMS.txt

Автоматическая сборка
---------------------
Workflow также запускается при push в main/master и при Pull Request в main/master.

Релиз
-----
Если создать git-тег вида v1.3.0, workflow соберёт EXE и опубликует его в GitHub Releases.

Важно
-----
Для релизов workflow использует GITHUB_TOKEN. Дополнительный секрет для публикации не требуется.

Пользовательский ПК
-------------------
После получения EXE сотруднику достаточно запустить установщик.
Node.js/npm/Git/GitHub на компьютере сотрудника не нужны.
