import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { User } from '@rental-record/contracts';
import type { AppConfig } from './config.js';
import { HttpError } from './errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    user: User;
  }
}

export const DEMO_USERS: User[] = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'jordan@example.com' },
  { id: '22222222-2222-4222-8222-222222222222', email: 'taylor@example.com' },
];
const loginSchema = z.object({ email: z.string().email(), password: z.string().max(200) }).strict();

function signature(body: string, config: AppConfig): Buffer {
  return createHmac('sha256', config.demoSecret).update(body).digest();
}

export function demoLogin(config: AppConfig): RequestHandler {
  return (req, res) => {
    if (config.mode !== 'demo' || config.isProduction)
      throw new HttpError(404, 'NOT_FOUND', 'This page was not found.');
    const input = loginSchema.parse(req.body);
    const user = DEMO_USERS.find((entry) => entry.email === input.email.toLowerCase());
    if (!user || input.password !== 'demo-pass-123')
      throw new HttpError(401, 'LOGIN_FAILED', 'The email or password is incorrect.');
    const body = Buffer.from(
      JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60 }),
    ).toString('base64url');
    res.json({ accessToken: `${body}.${signature(body, config).toString('base64url')}`, user });
  };
}

export function authenticate(config: AppConfig): RequestHandler {
  const supabase =
    config.mode === 'supabase'
      ? createClient(config.supabaseUrl!, config.supabaseAnonKey!, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        })
      : null;
  return async (req, _res, next) => {
    const authorization = req.get('Authorization');
    if (!authorization?.startsWith('Bearer '))
      throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    const token = authorization.slice(7);
    if (token.length > 8192)
      throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in again to continue.');
    if (config.mode === 'demo' && !config.isProduction) {
      try {
        const parts = token.split('.');
        if (parts.length !== 2) throw new Error('Invalid token');
        const expected = signature(parts[0], config);
        const supplied = Buffer.from(parts[1], 'base64url');
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
          throw new Error('Invalid signature');
        const payload: { sub: string; exp: number } = JSON.parse(
          Buffer.from(parts[0], 'base64url').toString('utf8'),
        );
        if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000))
          throw new Error('Expired');
        const user = DEMO_USERS.find((entry) => entry.id === payload.sub);
        if (!user) throw new Error('Unknown account');
        req.user = user;
      } catch {
        throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in again to continue.');
      }
    } else {
      const { data, error } = await supabase!.auth.getUser(token);
      if (error || !data.user)
        throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in again to continue.');
      req.user = { id: data.user.id, email: data.user.email || '' };
    }
    next();
  };
}
