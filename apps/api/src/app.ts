import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { PublicConfig } from '@rental-record/contracts';
import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import type { PhotoStorage } from './storage.js';
import { demoLogin } from './auth.js';
import { errorHandler, HttpError } from './errors.js';
import { createBusinessRouter } from './routes.js';

export interface Dependencies {
    db: Database;
    storage: PhotoStorage;
    config: AppConfig;
}

export function createApp({ db, storage, config }: Dependencies) {
    const app = express();
    app.disable('x-powered-by');
    if (config.isProduction) app.set('trust proxy', 1);
    app.use(
        helmet({
            referrerPolicy: { policy: 'no-referrer' },
            contentSecurityPolicy: config.isProduction
              ? {
                  directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    imgSrc: ["'self'", 'blob:', 'data:'],
                    connectSrc: ["'self'", new URL(config.supabaseUrl!).origin],
                    objectSrc: ["'none'"],
                    frameAncestors: ["'none'"],
                    baseUri: ["'self'"],
                  },
              }
            : false,
           strictTransportSecurity: config.isProduction,
        }),
    );
    app.use((req, _res, next) => {
        if(
            config.mode === 'demo' &&
            !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(req.hostname)
        ) {
            throw new HttpError(
                403,
                'HOST_NOT_ALLOWED',
                'The local demo is only available on this computer.',
            );
        }
        const origin = req.get('Origin');
        if (origin && origin !== config.appUrl)
            throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'This request came from a different site.');
        next();
    });
    app.use('/api', (_req, res, next) => {
        res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
        next();
    });
    if (!config.isTest)
        app.use(
            '/api',
            rateLimit({
                windowMs: 60_000,
                limit: 600,
                standardHeaders: 'draft-8',
                legacyHeaders: false,
                message: {
                    error: { code: 'RATE_LIMITED', message: 'Please wait a moment before trying again.' },
                },
            }),
        );
    app.use(express.json({ limit: '64kb' }));
    app.get('/api/health', async (_req, res) => {
        await db.query('SELECT 1');
        res.json({ status: 'ok' });
    });
    app.get('/api/config', (_req, res) => {
        const value: PublicConfig = { authMode: config.mode };
        if (config.mode === 'supabase') {
            value.supabaseUrl = config.supabaseUrl;
            value.supabaseAnonKey = config.supabaseAnonKey;
        }
        res.json(value);
    });
    if (config.mode === 'demo') {
        const limit = rateLimit({
            windowMs: 60_000,
            limit: 30,
            skip: () => config.isTest,
            legacyHeaders: false,
            standardHeaders: 'draft-8',
        });
        app.post('/api/demo/login', limit, demoLogin(config));
    }
    app.use('/api', createBusinessRouter({ db, storage, config }));
    app.use('/api', () => {
        throw new HttpError(404, 'NOT_FOUND', 'This API endpoint was not found.');
    });
    const webDirectory = path.resolve('dist/web');
    app.use(express.static(webDirectory, { index: false, maxAge: config.isProduction ? '1h': 0 }));
    app.get('/{*path}', (req, res, next) => {
        if (!req.accepts('html') || path.extname(req.path))
            return next(new HttpError(404, 'NOT_FOUND', 'This page was not found.'));
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(webDirectory, 'index.html'), (error) => {
            if (error) next(error);
        });
    });
    app.use(errorHandler);
    return app;    
}