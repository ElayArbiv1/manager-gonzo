'use strict';
/** Loads the sample-data files + employee rates into the database (demo mode). */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { openDb } = require('../server/db');

const dir = path.join(__dirname, '..', 'sample-data');
execFileSync(process.execPath, [path.join(__dirname, 'make-sample-data.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
const run = (file, source) => execFileSync(process.execPath, [path.join(__dirname, 'import.js'), path.join(dir, file), '--source', source], { stdio: 'inherit' });
run('shifts.csv', 'shift');
run('beecomm-sales.csv', 'beecomm');
run('website-orders.csv', 'website');
run('beecomm-items.csv', 'beecomm');
run('beecomm-cancellations.csv', 'beecomm');

const db = openDb();
const up = db.prepare('UPDATE employees SET role = ?, hourly_rate = ? WHERE name = ?');
for (const e of JSON.parse(fs.readFileSync(path.join(dir, 'employees-rates.json'), 'utf8'))) up.run(e.role, e.hourly_rate, e.name);
console.log('נתוני הדמו נטענו.');
