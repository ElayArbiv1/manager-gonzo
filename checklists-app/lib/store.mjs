/**
 * Storage: Netlify Blobs in production; a folder on disk when LOCAL_STORE_DIR is set
 * (local development and tests). Both expose the small subset of the Blobs API we use.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

function fileStore(dir) {
  const file = key => path.join(dir, ...key.split('/').map(encodeURIComponent));
  const metaFile = key => file(key) + '.__meta.json';
  return {
    async get(key, { type } = {}) {
      try {
        const buf = await fs.readFile(file(key));
        if (type === 'json') return JSON.parse(buf.toString('utf8'));
        if (type === 'arrayBuffer') return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        return buf.toString('utf8');
      } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async getWithMetadata(key, opts) {
      const data = await this.get(key, opts);
      if (data == null) return null;
      let metadata = {};
      try { metadata = JSON.parse(await fs.readFile(metaFile(key), 'utf8')); } catch { /* none */ }
      return { data, metadata };
    },
    async setJSON(key, value) {
      await fs.mkdir(path.dirname(file(key)), { recursive: true });
      await fs.writeFile(file(key), JSON.stringify(value));
    },
    async set(key, data, { metadata } = {}) {
      await fs.mkdir(path.dirname(file(key)), { recursive: true });
      await fs.writeFile(file(key), Buffer.from(data));
      if (metadata) await fs.writeFile(metaFile(key), JSON.stringify(metadata));
    },
    async delete(key) {
      await fs.rm(file(key), { force: true });
      await fs.rm(metaFile(key), { force: true });
    },
    async list({ prefix = '' } = {}) {
      const blobs = [];
      const walk = async (d, parts) => {
        let entries = [];
        try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.endsWith('.__meta.json')) continue;
          const p = [...parts, decodeURIComponent(e.name)];
          if (e.isDirectory()) await walk(path.join(d, e.name), p);
          else { const key = p.join('/'); if (key.startsWith(prefix)) blobs.push({ key }); }
        }
      };
      await walk(dir, []);
      return { blobs };
    }
  };
}

let cached = null;
export async function getStores() {
  if (cached) return cached;
  if (process.env.LOCAL_STORE_DIR) {
    const d = process.env.LOCAL_STORE_DIR;
    cached = { data: fileStore(path.join(d, 'data')), photos: fileStore(path.join(d, 'photos')) };
  } else {
    const { getStore } = await import('@netlify/blobs');
    cached = {
      data: getStore({ name: 'checklists', consistency: 'strong' }),
      photos: getStore({ name: 'checklist-photos', consistency: 'strong' })
    };
  }
  return cached;
}

/** For tests: start from an empty store. */
export function resetStores() { cached = null; }
