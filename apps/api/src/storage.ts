import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { AppConfig } from './config.js';

export interface StoredFile {
  key: string;
  createdAt: string;
}
export interface PhotoStorage {
  validate?(): Promise<void>;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(keys: string[]): Promise<void>;
  list(): Promise<StoredFile[]>;
}

function checkKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,255}\.webp$/.test(key))
    throw new Error('Invalid photo storage key.');
}

export function createStorage(config: AppConfig): PhotoStorage {
  if (config.mode === 'supabase') {
    const client = createClient(config.supabaseUrl!, config.supabaseServiceKey!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const bucket = client.storage.from(config.storageBucket);
    return {
      async validate() {
        const { data, error } = await client.storage.getBucket(config.storageBucket);
        if (error || !data)
          throw new Error('The configured photo bucket is not available.', { cause: error });
        if (data.public)
          throw new Error(
            'The photo bucket must be private. Public storage would bypass report access rules.',
          );
      },
      async put(key, bytes) {
        checkKey(key);
        const { error } = await bucket.upload(key, bytes, {
          contentType: 'image/webp',
          upsert: false,
          cacheControl: '0',
        });
        if (error) throw new Error('photo storage write failed.', { cause: error });
      },
      async get(key) {
        checkKey(key);
        const { data, error } = await bucket.download(key);
        if (error || !data) throw new Error('photo storage read failed.', { cause: error });
        return Buffer.from(await data.arrayBuffer());
      },
      async remove(keys) {
        keys.forEach(checkKey);
        for (let offset = 0; offset < keys.length; offset += 100) {
          const { error } = await bucket.remove(keys.slice(offset, offset + 100));
          if (error) throw new Error('Photo storage cleanup failed.', { cause: error });
        }
      },
      async list() {
        const files: StoredFile[] = [];
        async function walk(prefix: string) {
          for (let offset = 0; ; offset += 1000) {
            const { data, error } = await bucket.list(prefix, {
              limit: 1000,
              offset,
              sortBy: { column: 'name', order: 'asc' },
            });
            if (error) throw new Error('Photo storage listing failed.', { cause: error });
            for (const entry of data || []) {
              const key = prefix ? `${prefix}/${entry.name}` : entry.name;
              if (!entry.id) await walk(key);
              else files.push({ key, createdAt: entry.created_at || new Date().toISOString() });
            }
            if (!data || data.length < 1000) break;
          }
        }
        await walk('');
        return files;
      },
    };
  }

  const directory = path.join(config.dataDir, 'photos');
  const filePath = (key: string) => {
    checkKey(key);
    return path.join(directory, key);
  };
  return {
    async put(key, bytes) {
      const file = filePath(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    },
    async get(key) {
      return fs.readFile(filePath(key));
    },
    async remove(keys) {
      for (const key of keys) await fs.rm(filePath(key), { force: true });
    },
    async list() {
      const files: StoredFile[] = [];
      async function walk(relative: string) {
        const folder = path.join(directory, relative);
        let entries;
        try {
          entries = await fs.readdir(folder, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        for (const entry of entries) {
          const key = [relative, entry.name].filter(Boolean).join('/');
          if (entry.isDirectory()) await walk(key);
          else if (entry.isFile() && entry.name.endsWith('.webp')) {
            const stat = await fs.stat(path.join(directory, key));
            files.push({ key, createdAt: stat.birthtime.toISOString() });
          }
        }
      }
      await walk('');
      return files;
    },
  };
}
