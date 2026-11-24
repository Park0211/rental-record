import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { expect } from 'vitest';
import sharp from 'sharp';
import type { Condition, InspectionView, Report, Stay } from '@rental-record/contracts';
import { createApp } from '../../apps/api/src/app.js';
import { readConfig } from '../../apps/api/src/config.js';
import { createDatabase, migrate } from '../../apps/api/src/db.js';
import { createStorage, type PhotoStorage } from '../../apps/api/src/storage.js';

export const jordanId = '11111111-1111-4111-8111-111111111111';
export const taylorId = '22222222-2222-4222-8222-222222222222';

export interface TestRecord {
    stay: Stay;
    inspectionId: string;
}

export async function createHarness() {
    const dataDir = await mkdtemp(join(tmpdir(), 'rental-record-api-'));
    const config = readConfig({
        mode: 'demo',
        host: '127.0.0.1',
        port: 4173,
        appUrl: 'http://127.0.0.1:4173',
        dataDir,
        databaseUrl: process.env.TEST_DATABASE_URL || undefined,
        databaseSsl: false,
        isProduction: false,
        isTest: true,
    });
    const db = await createDatabase(config);
    await migrate(db);
    const localStorage = createStorage(config);
    const faults = { put: false, remove: false };
    const storage: PhotoStorage = {
        put: async (key, bytes) => {
            if (faults.put) throw new Error('Storage unavailable during test');
            await localStorage.put(key, bytes);
        },
        get: (key) => localStorage.get(key),
        remove: async (keys) => {
            if (faults.remove) throw new Error('Storage unavailable during test');
            await localStorage.remove(keys);
        },
        list: () => localStorage.list(),
    };
    const app = createApp({ db, storage, config });

    async function login(email = 'jordan@example.com') {
        const result = await request(app)
            .post('/api/demo/login')
            .send({ email, password: 'demo-pass-123'});
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body.accessToken as string;
    }

    const token = await login();
    const otherToken =await login('taylor@example.com');

    function api(method: 'get' | 'post' | 'patch' | 'delete', path: string, accessToken = token) {
        return request(app)[method](path).set('Authorization', `Bearer ${accessToken}`);
    }

    async function makeRecord(
        title = `Test apartment ${randomUUID()}`,
        accessToken = token,
    ): Promise<TestRecord> {
        const result = await api('post', '/api/stays', accessToken).send({
            title,
            city: 'Boston',
            state: 'MA',
            timeZone: 'America/New_York',
            roomTypes: ['other'],
        });
        expect(result.status, JSON.stringify(result.body)).toBe(201);
        return { stay: result.body.stay, inspectionId: result.body.inspection.id };
    }

    async function getInspection(inspectionId: string, accessToken = token): Promise<InspectionView> {
        const result = await api('get', `/api/inspections/${inspectionId}`, accessToken);
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body as InspectionView;
    }

    async function fillInspection(
        record: TestRecord,
        options: { condition?: Condition; notes?: string; date?: string } = {},
    ) {
        let current = await getInspection(record.inspectionId);
        const date = await api('patch', `/api/inspections/${record.inspectionId}`).send({
            inspectionDate: options.date ?? '2025-01-15',
            expectedEditVersion: current.inspection.editVersion,
        });
        expect(date.status, JSON.stringify(date.body)).toBe(200);
        let version = date.body.editVersion as number;
        for (const room of current.rooms) {
          for (const item of room.items) {
            const saved = await api('patch', `/api/observations/${item.observation.id}`).send({
                condition: options.condition ?? 'no_issue',
                notes: options.notes ?? '',
                expectedEditVersion: version,
            });
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            version = saved.body.editVersion as number;
          }
        }
        current = await getInspection(record.inspectionId);
        return current;
    }

    async function complete(inspectionId: string, requestId = randomUUID()) {
        const current = await getInspection(inspectionId);
        const result = await api('post', `/api/inspections/${inspectionId}/complete`).send({
            requestId,
            expectedEditVersion: current.inspection.editVersion,
        });
        expect([200, 201], JSON.stringify(result.body)).toContain(result.status);
        return result.body as { reportId: string; editVersion: number };
    }

    async function getReport(reportId: string): Promise<Report> {
        const result = await api('get', `/api/reports/${reportId}`);
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body as Report;
    }

    async function addPhoto(
        inspectionId: string,
        file: Buffer,
        clientUploadId = randomUUID(),
        mime = 'image/jpeg',
        filename = 'wall.jpg',
    ) {
        const current = await getInspection(inspectionId);
        const item = current.rooms[0]!.items[0]!;
        return api('post', `/api/observations/${item.observation.id}/photos`)
        .field('clientUploadId', clientUploadId)
        .field('expectedEditVersion', String(current.inspection.editVersion))
        .attach('file', file, { filename, contentType: mime });
    }

    async function close() {
        await db.close();
        await rm(dataDir, { recursive: true, force: true });
    }

    return {
        app,
        db,
        config,
        storage,
        localStorage,
        faults,
        token,
        otherToken,
        api,
        login,
        makeRecord,
        getInspection,
        fillInspection,
        complete,
        getReport,
        addPhoto,
        close,
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export function imageBuffer(width = 80, height = 60, color = '#c8d7c6') {
    return sharp({ create: { width, height, channels: 3, background: color }})
    .jpeg()
    .toBuffer();
}

export function binaryParser(
    response: Response,
    callback: (error: Error | null, body: Buffer) => void,
) {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
    response.on('error', (error:Error) => callback(error, Buffer.alloc(0)));
}

export function expectUploadSuccess(result: Response) {
    expect([200, 201], JSON.stringify(result.body)).toContain(result.status);
    expect(result.body.photo.status).toBe('ready');
    return result.body as { photo: import('@rental-record/contracts').Photo; editVersion: number };
}

