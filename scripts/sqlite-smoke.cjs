const { DatabaseSync } = require('node:sqlite');

const database = new DatabaseSync(':memory:');

database.exec(`
  CREATE TABLE smoke_check (
    id INTEGER PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
database
  .prepare('INSERT INTO smoke_check (id, value) VALUES (?, ?)')
  .run(1, 'electron-native-module-ok');

const row = database
  .prepare('SELECT value FROM smoke_check WHERE id = ?')
  .get(1);

if (row?.value !== 'electron-native-module-ok') {
  database.close();
  throw new Error('SQLite smoke check failed.');
}

database.close();
console.log('SQLite built-in module smoke check passed.');
