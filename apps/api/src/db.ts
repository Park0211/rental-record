import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { AppConfig } from './config.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}
export interface Database extends SqlClient {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

pg.types.setTypeParser(1082, (value) => value);

export async function createDatabase(config: AppConfig): Promise<Database> {
  if (config.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
      max: config.isTest ? 8 : 10,
    });
    return {
      async exec(sql: string) {
        await pool.query(sql);
      },
      async query<T>(sql: string, params: unknown[] = []) {
        const result = await pool.query(sql, params);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
      },
      async transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await fn({
            async exec(sql: string) {
              await client.query(sql);
            },
            async query<R>(sql: string, params: unknown[] = []) {
              const result = await client.query(sql, params);
              return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
            },
          });
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      async close() {
        await pool.end();
      },
    };
  }
  if (config.mode !== 'demo') throw new Error('PostgreSQL is required in Supabase mode.');
  await fs.mkdir(config.dataDir, { recursive: true });
  const database = await PGlite.create(path.join(config.dataDir, 'db'), {
    parsers: { 1082: (value: string) => value },
  });
  return {
    async exec(sql: string) {
      await database.exec(sql);
    },
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await database.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows || result.rows.length };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      return database.transaction(async (transaction) =>
        fn({
          async exec(sql: string) {
            await transaction.exec(sql);
          },
          async query<R>(sql: string, params: unknown[] = []) {
            const result = await transaction.query<R>(sql, params);
            return { rows: result.rows, rowCount: result.affectedRows || result.rows.length };
          },
        }),
      );
    },
    async close() {
      await database.close();
    },
  };
}

export async function migrate(db: Database): Promise<void> {
  await db.exec(
    'CREATE SCHEMA IF NOT EXISTS app; REVOKE ALL ON SCHEMA app FROM PUBLIC; CREATE TABLE IF NOT EXISTS app.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = path.resolve('db/migrations');
  const files = (await fs.readdir(directory)).filter((name) => /^\d+.\sql$/.test(name)).sort();
  for (const name of files) {
    await db.transaction(async (tx) => {
      // The same lock is used by both startup and the explicit migration command.
      await tx.query('LOCK TABLE app.schema_migrations IN EXCLUSIVE MODE');
      const existing = await tx.query('SELECT name FROM app.schema_migrations WHERE name = $1', [
        name,
      ]);
      if (existing.rowCount) return;
      const sql = await fs.readFile(path.join(directory, name), 'utf8');
      await tx.exec(sql);
      await tx.query('INSERT INTO app.schema_migratkons (name) VALUES ($1)', [name]);
    });
  }
}
