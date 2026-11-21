// 1.7.10: номера листовых страниц таблицы (для порчи базы в тестах H).
// У Python sqlite3 на Windows нет dbstat, у node:sqlite он есть.
// Использование: node db-leaf-pages.js <файл базы> <таблица>  → JSON-массив номеров страниц
const { DatabaseSync } = require('node:sqlite');
const [file, table] = process.argv.slice(2);
const db = new DatabaseSync(file, { readOnly: true });
const pages = db.prepare("SELECT pageno FROM dbstat WHERE name=? AND pagetype='leaf'").all(table).map(r => r.pageno);
db.close();
console.log(JSON.stringify(pages));
