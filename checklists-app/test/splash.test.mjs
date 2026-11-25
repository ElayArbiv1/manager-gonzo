import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSplashList } from '../scripts/build.mjs';

test('loading-screen list is built from the images in the folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splash-'));
  for (const f of ['b.jpg', 'a photo.PNG', 'c.webp', 'notes.txt', '.hidden.jpg']) fs.writeFileSync(path.join(dir, f), 'x');
  const list = buildSplashList(dir);
  assert.deepEqual(list, ['/splash/a%20photo.PNG', '/splash/b.jpg', '/splash/c.webp']);
  const js = fs.readFileSync(path.join(dir, 'list.js'), 'utf8');
  const win = {};
  new Function('window', js)(win);
  assert.deepEqual(win.SPLASH_IMAGES, list);
  assert.deepEqual(buildSplashList(fs.mkdtempSync(path.join(os.tmpdir(), 'splash-empty-'))), []);
});
