import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../apps/api/src/config.js';
import { createStorage } from '../apps/api/src/storage.js';

const config = readConfig({
  mode: 'supabase',
  isProduction: false,
  isTest: true,
  databaseUrl: 'postgresql://unused:unused@127.0.0.1/unused',
  supabaseUrl: 'https://storage-test.example.invalid',
  supabaseAnonKey: 'public-test-key',
  supabaseServiceKey: 'server-test-key',
});

afterEach(() => vi.unstubAllGlobals());

describe('photo bucket startup check', () => {
  it('accepts the configured private bucket', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ id: config.storageBucket, name: config.storageBucket, public: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
    );
    await expect(createStorage(config).validate!()).resolves.toBeUndefined();
  });

  it('reject a public bucket that would bypass report access rules', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ id: config.storageBucket, name: config.storageBucket, public: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
    );
    await expect(createStorage(config).validate!()).rejects.toThrow('must be private');
  });

  it('stops startup when the configured bucket cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messages: 'Bucket not found ' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(createStorage(config).validate!()).rejects.toThrow('not available');
  });
});
