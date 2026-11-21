#!/bin/sh
# Весь набор: логика, стенд, откат на прошлую версию. Запуск из папки версии: sh dev-tests/run_all.sh <папка прошлой версии>
export PYTHONUTF8=1
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
python dev-tests/e2e/tests_e2e.py . 2>&1 | grep -v "^✅"
[ -n "$1" ] && python dev-tests/e2e/tests_e2e.py . L --prev "$1" 2>&1 | grep -v "^✅"
