import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { LIMITS } from '@rental-record/contracts';
import type { Database } from './db.js';
import type { AppConfig } from './config.js';
import type { PhotoStorage } from './storage.js';
import { authenticate } from './auth.js';
import { HttpError } from './errors.js';
import {
    parse,
    uuid,
    listQuery,
    versionBody,
    roomBody,
    roomNameBody,
    itemBody,
    shareBody,
    deleteStayBody,
    photoBody,
} from './services/validation.js';
import {
    createStay,
    listStays,
    getStay,
    getSetup,
    updateStay,
    addRoom,
    renameRoom,
    addItem,
    renameItem,
    removeStructure,
    setArchived,
} from './services/stays.js';
import {
    getInspection,
    updateInspection,
    updateObservation,
    completeInspection,
    reopenInspection,
    startMoveOut,
    getComparison,
} from './services/inspections.js';
import { uploadPhoto, removePhoto, ownerPhoto } from './services/photos.js';
import {
    getReport,
    listReports,
    createShare,
    listShares,
    revokeShare,
    getSharedReport,
    getSharedPhoto,
} from './services/reports.js';
import { deleteStay } from './services/cleanup.js';

export interface Dependencies {
    db: Database;
    storage: PhotoStorage;
    config: AppConfig;
}

function parameter(req: Request, name: string) {
    return parse(uuid, req.params[name]);
}
function tokenParameter(req: Request) {
    const token = req.params.token;
    if (typeof token !== 'string')
        throw new HttpError(404, 'LINK_UNAVAILABLE', 'This link is no longer available.');
    return token;
}
function variant(req: Request): 'preview' | 'full' {
    if (req.query.variant === undefined || req.query.variant === 'preview') return 'preview';
    if (req.query.variant === 'full') return 'full';
    throw new HttpError(400, 'INVALID_VARIANT', 'Choose the preview or full photo.');
}
function sendPhoto(res: Response, bytes: Buffer) {
    res
      .set({
        'Cache-Control': 'private, no-store',
        'Content-Type': 'image/webp',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      })
      .send(bytes);
}

export function createBusinessRouter({ db, storage, config }: Dependencies) {
    const router = Router();
    const deps = { db, storage };
    router.use(
        '/shared',
        rateLimit({
            windowMs: 60_000,
            limit: 300,
            standardHeaders: 'draft-8',
            legacyHeaders: false,
            skip: () => config.isTest,
            message: {
                error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
            },
        }),
    );
    router.get('/shared/:token', async (req, res) => {
        res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
        res.json(await getSharedReport(db, tokenParameter(req)));
    });
    router.get('/shared/:token/photos/:photoId', async (req, res) => {
        res.set('Referrer-Policy', 'no-referrer');
        sendPhoto(
            res,
            await getSharedPhoto(
                db,
                storage,
                tokenParameter(req),
                parameter(req, 'photoId'),
                variant(req),
            ),
        );
    });

    router.use(authenticate(config));
    router.get('/me', (req, res) => {
        res.json(req.user);
    });
    router.get('/stays', async (req, res) => {
        res.json(await listStays(db,req.user!.id, listQuery(req.query)));
    });
    router.post('/stays', async (req, res) => {
        res.status(201).json(await createStay(db, req.user!.id, req.body));
    });
    router.get('/stays/:stayId', async (req, res) => {
        res.json(await getStay(db, req.user!.id, parameter(req, 'stayId')));
    });
    router.patch('/stays/:stayId', async (req, res) => {
        res.json(await updateStay(db, req.user!.id, parameter(req, 'stayId'), req.body));
    });
    router.delete('/stays/:stayId', async (req, res) => {
        const data = parse(deleteStayBody, req.body);
        res
          .status(202)
          .json(await deleteStay(deps, req.user!.id, parameter(req, 'stayId'), data.confirmationTitle));
    });
    router.get('/stays/:stayId/setup', async (req, res) => {
        res.json(await getSetup(db, req.user!.id, parameter(req, 'stayId')));
    });
    router.post('/stays/:stayId/rooms', async (req, res) => {
        res
          .status(201)
          .json(await addRoom(db, req.user!.id, parameter(req, 'stayId'), parse(roomBody, req.body)));
    });
    router.patch('/rooms/:roomId', async (req, res) => {
        res.json(
            await renameRoom(db, req.user!.id, parameter(req, 'roomId'), parse(roomNameBody, req.body)),
        );
    });
    router.delete('/rooms/:roomId', async (req, res) => {
        res.json(
            await removeStructure(
                db,
                storage,
                req.user!.id,
                parameter(req, 'roomId'),
                'room',
                parse(versionBody, req.body).expectedEditVersion,
            ),
        );
    });
    router.post('/rooms/:roomId/items', async (req, res) => {
        res
          .status(201)
          .json(await addItem(db, req.user!.id, parameter(req, 'roomId'), parse(itemBody, req.body)));
    });
    router.patch('/items/:itemId', async (req, res) => {
        res.json(
            await renameItem(db, req.user!.id, parameter(req, 'itemId'), parse(itemBody, req.body)),
        );
    });
    router.delete('/items/:itemId', async (req, res) => {
        res.json(
            await removeStructure(
                db,
                storage,
                req.user!.id,
                parameter(req, 'itemId'),
                'item',
                parse(versionBody, req.body).expectedEditVersion,
            ),
        );
    });
    router.get('/inspections/:inspectionId', async (req, res) => {
        res.json(await getInspection(db, req.user!.id, parameter(req, 'inspectionId')));
    });
    router.patch('/inspections/:inspectionId', async (req, res) => {
        res.json(await updateInspection(db, req.user!.id, parameter(req, 'inspectionId'), req.body));
    });
    router.patch('/observations/:observationId', async (req, res) => {
        res.json(await updateObservation(db, req.user!.id, parameter(req, 'observationId'), req.body));
    });

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: LIMITS.photoBytes, files: 1, fields: 2, parts: 3, fieldSize: 1024 },
    });
    const uploadLimiter = rateLimit({
        windowMs: 60_000,
        limit: 30,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        keyGenerator: (req) => req.user!.id,
        skip: () => config.isTest,
        message: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many uploads. Wait a minute before trying again.',
          },
        },
    });
    router.post(
        '/observations/:observationId/photos',
        uploadLimiter,
        upload.single('file'),
        async (req, res) => {
            if (!req.file) throw new HttpError(400, 'PHOTO_REQUIRED', 'Choose a photo to upload.');
            const result = await uploadPhoto(
                deps,
                req.user!.id,
                parameter(req, 'observationId'),
                parse(photoBody, req.body),
                req.file,
            );
            res
              .status(result.photo.status === 'pending' ? 202 : result.existing ? 200 : 201)
              .json({ photo: result.photo, editVersion: result.editVersion });
        },
    );
    router.delete('/photos/:photoId', async (req, res) => {
        res.json(
            await removePhoto(
                deps,
                req.user!.id,
                parameter(req, 'photoId'),
                parse(versionBody, req.body).expectedEditVersion,
            ),
        );
    });
    router.get('/photos/:photoId/content', async (req, res) => {
        sendPhoto(
            res,
            await ownerPhoto(db, storage, req.user!.id, parameter(req, 'photoId'), variant(req)),
        );
    });
    router.post('/inspections/:inspectionId/complete', async (req, res) => {
        res
          .status(201)
          .json(await completeInspection(db, req.user!.id, parameter(req, 'inspectionId'), req.body));
    });
    router.post('/inspections/:inspectionId/reopen', async (req, res) => {
        res.json(
            await reopenInspection(
                db,
                req.user!.id,
                parameter(req, 'inspectionId'),
                parse(versionBody, req.body).expectedEditVersion,
            ),
        );
    });
    router.post('/stays/:stayId/move-out', async (req, res) => {
        res.status(201).json(await startMoveOut(db, req.user!.id, parameter(req, 'stayId'), req.body));
    });
    router.get('/stays/:stayId/comparison', async (req, res) => {
        res.json(await getComparison(db, req.user!.id, parameter(req, 'stayId')));
    });
    router.get('/stays/:stayId/reports', async (req, res) => {
        res.json(await listReports(db, req.user!.id, parameter(req, 'stayId')));
    });
    router.get('/reports/:reportId', async (req, res) => {
        res.json(await getReport(db, req.user!.id, parameter(req, 'reportId')));
    });
    router.post(['/reports/:reportId/share-links', '/reports/:reportId/shares'], async (req, res) => {
        const data = parse(shareBody, req.body);
        res
          .status(201)
          .json(
            await createShare(
                db,
                req.user!.id,
                parameter(req, 'reportId'),
                data.expiresInDays,
                config.appUrl,
            ),
          );
    });
    router.get(['/reports/:reportId/share-links', '/reports/:reportId/shares'], async (req, res) => {
        res.json(await listShares(db, req.user!.id, parameter(req, 'reportId')));
    });
    router.delete(['/share-links/:shareId', '/shares/:shareId'], async (require, res) => {
        await revokeShare(db, require.user!.id, parameter(require, 'shareId'));
        res.sendStatus(204);
    });
    router.post('/stays/:stayId/archive', async (req, res) => {
        res.json(await setArchived(db, req.user!.id, parameter(req, 'stayId'), true));
    });
    router.post('/stays/:stayId/unarchive', async (req, res) => {
        res.json(await setArchived(db, req.user!.id, parameter(req, 'stayId'), false));
    });
    return router;
}