import path from 'node:path';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export interface AppConfig {
  mode: 'demo' | 'supabase';
  port: number;
  host: string;
  appUrl: string;
  dataDir: string;
  databaseUrl?: string;
  databaseSsl: boolean;
  supabaseUrl?: string;
  supabaseAnonkey?: string;
  supabaseServiceKey?: string;
  storageBucket: string;
  isProduction: boolean;
  isTest: boolean;
  demoSecret: string;
}

export function readConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const mode = process.env.APP_MODE || 'demo';
  if (mode !== 'demo' && mode !== 'supabase') throw new Error('APP_MODE must be demo or supabase.');
  const config: AppConfig = {
    mode,
    port: Number(process.env.PORT || 3001),
    host: mode === 'demo' ? '127.0.0.1' : '0.0.0.0',
    appUrl: process.env.APP_URL || 'http://127.0.0.1:5173',
    dataDir: path.resolve(process.env.DATA_DIR || '.data'),
    databaseUrl: process.env.DATABASE_URL || undefined,
    databaseSsl: process.env.DATABASE_SSL !== 'false',
    supabaseUrl: process.env.SUPABASE_URL || undefined,
    supabaseAnonkey: process.env.SUPABASE_ANON_KEY || undefined,
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    storageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'condition-photos',
    isProduction: process.env.NODE_ENV === 'production',
    isTest: process.env.NODE_ENV === 'test',
    demoSecret: randomBytes(48).toString('base64url'),
    ...overrides,
  };
  if (
    !Number.isInteger(config.port) ||
    config.port < (config.isTest ? 0 : 1) ||
    config.port > 65535
  )
    throw new Error('PORT must be between 1 and 65535.');
  const origin = new URL(config.appUrl);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== config.appUrl.replace(/\/$/, '')
  )
    throw new Error('APP_URL must be an HTTP origin without a path');
  config.appUrl = origin.origin;
  config.dataDir = path.resolve(config.dataDir);
  if (config.mode === 'demo') {
    if (config.isProduction)
      throw new Error('Demo mode is local only. Set APP_MODE=supabase for production.');
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host))
      throw new Error('Demo mode must bind to loopback.');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
      throw new Error('Demo APP_URL must use localhost or a loopback address.');
  } else {
    for (const key of [
      'databaseUrl',
      'supabaseUrl',
      'supabaseAnonkey',
      'supabaseServiceKey',
    ] as const) {
      if (!config[key]) throw new Error(`Missing configuration: ${key}`);
    }
    const supabase = new URL(config.supabaseUrl!);
    if (supabase.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(supabase.hostname))
      throw new Error('SUPABASE_URL must use HTTPS.');
    if (config.isProduction && origin.protocol !== 'https:')
      throw new Error('Production APP_URL must use HTTPS.');
  }
  return config;
}
