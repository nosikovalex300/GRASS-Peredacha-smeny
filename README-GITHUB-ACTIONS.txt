GRASS — GitHub Actions / автоматические релизы

Что умеет проект:
- Сборка Windows NSIS-установщика на GitHub Windows runner.
- Node.js/npm на компьютере сотрудника не нужны.
- Обычный push в main/master или ручной запуск Actions создаёт Artifact с установщиком.
- Тег вида vMAJOR.MINOR.PATCH автоматически создаёт GitHub Release.
- При релизе версия package.json на runner автоматически синхронизируется с тегом.
- В Release прикладываются Setup.exe и SHA256SUMS.txt.

Как выпустить новую версию:
1. Измените проект.
2. Измените version в package.json на нужную версию, например 1.4.0.
3. Сделайте commit и push в main.
4. Создайте тег:
   git tag v1.4.0
5. Отправьте тег:
   git push origin v1.4.0
6. GitHub Actions автоматически соберёт Windows installer и создаст GitHub Release.

Важно:
- Не удаляйте AppData вручную: SQLite-база и backups хранятся отдельно от программы.
- GitHub Release хранит установщик; это не рабочая база данных приложения.
