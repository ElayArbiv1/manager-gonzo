// Copies the shared checklist screens + base styles from the main app, so both apps use the same code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = path.resolve(here, '..', 'public', 'shared');
fs.mkdirSync(out, { recursive: true });
for (const f of ['checklists.js', 'styles.css']) fs.copyFileSync(path.join(root, 'public', f), path.join(out, f));
console.log('shared files copied to public/shared');
