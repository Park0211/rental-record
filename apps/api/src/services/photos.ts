import { createHash, randomUUID } from 'node:crypto';
import sharp, { type OutputInfo } from 'sharp';
import { LIMITS } from '@rental-record/contracts';
import type { Database } from '../db.js';
import type { PhotoStorage } from '../storage.js';
import { HttpError } from '../errors.js';
import {
  bumpVersion,
  editable,
  lockInspection,
  ownedStay,
  photoView,
  type ObservationRow,
  type PhotoRow,
  type StayRow,
  type InspectionRow,
} from './rows.js';

interface UploadInput {
  clientUploadId: string;
  expectedEditVersion: number;
}
interface UploadFile {
  buffer: Buffer;
  size: number;
  mimetype: string;
  originalname: string;
}
interface Dependencies {
  db: Database;
  storage: PhotoStorage;
}

export async function uploadPhoto(
  { db, storage }: Dependencies,
  userId: string,
  observationId: string,
  data: UploadInput,
  file: UploadFile,
) {
  if (file.size > LIMITS.photoBytes)
    throw new HttpError(413, 'FILE_TOO_LARGE', 'Photos must be 10 MiB or smaller.');
  const hash = createHash('sha256').update(file.buffer).digest('hex');
  const reservation = await db.transaction(async (tx) => {
    const observed = await tx.query<ObservationRow>('SELECT * FROM app.observations WHERE id=$1', [
      observationId,
    ]);
    if (!observed.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'This item is not available.');
    const { stay, inspection } = await lockInspection(tx, userId, observed.rows[0].inspection_id);
    const prior = await tx.query<PhotoRow>(
      'SELECT * FROM app.photos WHERE stay_id=$1 AND client_upload_id=$2',
      [stay.id, data.clientUploadId],
    );
    if (prior.rows[0]) {
      const photo = prior.rows[0];
      if (
        photo.observation_id !== observationId ||
        photo.source_sha256 !== hash ||
        photo.removed_at
      ) {
        throw new HttpError(
          409,
          'UPLOAD_ID_REUSED',
          'This upload ID belongs to another or removed upload.',
        );
      }
      return {
        photo,
        inspectionId: inspection.id,
        editVersion: inspection.edit_version,
        existing: true,
      };
    }
    editable(stay, inspection, data.expectedEditVersion);
    const stillExists = await tx.query('SELECT id FROM app.observations WHERE id=$1', [
      observationId,
    ]);
    if (!stillExists.rowCount) throw new HttpError(404, 'NOT_FOUND', 'This item is not available.');
    const counts = await tx.query<{ item_count: string; inspection_count: string }>(
      `SELECT
            count(*) FILTER (WHERE p.observation_id=$1) AS item_count, count(*) AS inspection_count
            FROM app.photos p JOIN app.observations o ON o.id=p.observation_id WHERE o.inspection_id=$2 AND p.removed_at IS NULL`,
      [observationId, inspection.id],
    );
    if (
      Number(counts.rows[0]!.item_count) >= LIMITS.photosPerItem ||
      Number(counts.rows[0]!.inspection_count) >= LIMITS.photosPerInspection
    ) {
      throw new HttpError(
        422,
        'PHOTO_LIMIT',
        'Use up to 5 photos per item and 40 photos per inspection. Remove a failed upload before trying again.',
      );
    }
    const id = randomUUID();
    const result = await tx.query<PhotoRow>(
      `INSERT INTO app.photos
            (id,stay_id,observation_id,client_upload_id,source_sha256,storage_key,preview_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        id,
        stay.id,
        observationId,
        data.clientUploadId,
        hash,
        `${stay.id}/${id}/full.webp`,
        `${stay.id}/${id}/preview.webp`,
      ],
    );
    return {
      photo: result.rows[0]!,
      inspectionId: inspection.id,
      editVersion: await bumpVersion(tx, inspection.id),
      existing: false,
    };
  });
  if (reservation.existing)
    return {
      photo: photoView(reservation.photo),
      editVersion: reservation.editVersion,
      existing: true,
    };

  const { photo, inspectionId } = reservation;
  try {
    let full: { data: Buffer; info: OutputInfo };
    let preview: Buffer;
    try {
      const input = sharp(file.buffer, { limitInputPixels: LIMITS.imagePixels, failOn: 'warning' });
      const meta = await input.metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1) {
        throw new HttpError(415, 'UNSUPPORTED_IMAGE', 'Choose a still JPEG, PNG, or WebP image.');
      }
      if (!meta.width || !meta.height || meta.width * meta.height > LIMITS.imagePixels) {
        throw new HttpError(
          413,
          'IMAGE_TOO_LARGE',
          'Photos must contain no more than 50 megapixels.',
        );
      }
      full = await input
        .clone()
        .rotate()
        .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
      preview = await input
        .clone()
        .rotate()
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof Error && /pixel limit/i.test(error.message)) {
        throw new HttpError(
          413,
          'IMAGE_TOO_LARGE',
          'Photos must contain no more than 50 megapixels.',
        );
      }
      throw new HttpError(
        415,
        'INVALID_IMAGE',
        'The file could not be read as a JPEG, PNG, or WebP image.',
      );
    }
    await storage.put(photo.storage_key, full.data);
    await storage.put(photo.preview_key, preview);
    const result = await db.transaction(async (tx) => {
      const stays = await tx.query<StayRow>('SELECT * FROM app.stays WHERE id=$1 FOR UPDATE', [
        photo.stay_id,
      ]);
      if (!stays.rows[0] || stays.rows[0].deleted_at) return null;
      const inspections = await tx.query<InspectionRow>(
        'SELECT * FROM app.inspections WHERE id=$1 FOR UPDATE',
        [inspectionId],
      );
      const found = await tx.query<PhotoRow>('SELECT * FROM app.photos WHERE id=$1 FOR UPDATE', [
        photo.id,
      ]);
      if (
        !inspections.rows[0] ||
        !found.rows[0] ||
        found.rows[0].removed_at ||
        found.rows[0].status !== 'pending'
      )
        return null;
      const updated = await tx.query<PhotoRow>(
        `UPDATE app.photos SET status ='ready',byte_size=$2,width=$3,height=$4,uploaded_at=now(),last_error=NULL WHERE id=$1 RETURNING *`,
        [photo.id, full.data.length, full.info.width, full.info.height],
      );
      return {
        photo: photoView(updated.rows[0]!),
        editVersion: await bumpVersion(tx, inspectionId),
        existing: false,
      };
    });
    if (!result) {
      await storage.remove([photo.storage_key, photo.preview_key]).catch(() => undefined);
      throw new HttpError(
        409,
        'UPLOAD_CANCELLED',
        'This upload was removed or the record was deleted.',
      );
    }
    return result;
  } catch (error) {
    await storage.remove([photo.storage_key, photo.preview_key]).catch(() => undefined);
    const problem =
      error instanceof HttpError
        ? error
        : new HttpError(
            503,
            'PHOTO_STORAGE_FAILED',
            'The photo could not be stored. Retry or remove this upload.',
          );
    const version = await db.transaction(async (tx) => {
      const stays = await tx.query<StayRow>('SELECT * FROM app.stays WHERE id=$1 FOR UPDATE', [
        photo.stay_id,
      ]);
      if (!stays.rows[0] || stays.rows[0].deleted_at) return null;
      const inspection = await tx.query<InspectionRow>(
        'SELECT * FROM app.inspections WHERE id=$1 FOR UPDATE',
        [inspectionId],
      );
      if (!inspection.rows[0]) return null;
      const updated = await tx.query(
        "UPDATE app.photos SET status='failed',last_error=$2 WHERE id=$1 AND removed_at IS NULL AND status='pending'",
        [photo.id, problem.message],
      );
      return updated.rowCount ? bumpVersion(tx, inspectionId) : inspection.rows[0].edit_version;
    });
    throw new HttpError(problem.status, problem.code, problem.message, {
      photoId: photo.id,
      editVersion: version,
    });
  }
}

export async function removePhoto(
  { db, storage }: Dependencies,
  userId: string,
  photoId: string,
  expectedEditVersion: number,
) {
  const result = await db.transaction(async (tx) => {
    const found = await tx.query<PhotoRow & { inspection_id: string }>(
      `SELECT p.*,o.inspection_id FROM app.photos p JOIN app.observations o ON o.id=p.observation_id WHERE p.id=$1`,
      [photoId],
    );
    const photo = found.rows[0];
    if (!photo) throw new HttpError(404, 'NOT_FOUND', 'This photo is not available.');
    const { stay, inspection } = await lockInspection(tx, userId, photo.inspection_id);
    editable(stay, inspection, expectedEditVersion);
    const updated = await tx.query(
      'UPDATE app.photos SET removed_at=now() WHERE id=$1 AND removed_at IS NULL',
      [photoId],
    );
    const references = await tx.query('SELECT photo_id FROM app.report_photos WHERE photo_id=$1', [
      photoId,
    ]);
    return {
      editVersion: updated.rowCount
        ? await bumpVersion(tx, inspection.id)
        : inspection.edit_version,
      keys: references.rowCount ? [] : [photo.storage_key, photo.preview_key],
    };
  });
  if (result.keys.length) await storage.remove(result.keys).catch(() => undefined);
  return { editVersion: result.editVersion };
}

export async function ownerPhoto(
  db: Database,
  storage: PhotoStorage,
  userId: string,
  photoId: string,
  variant: 'preview' | 'full',
) {
  const result = await db.query<PhotoRow>('SELECT * FROM app.photos WHERE id=$1', [photoId]);
  const photo = result.rows[0];
  if (!photo) throw new HttpError(404, 'NOT_FOUND', 'This photo is not available.');
  await ownedStay(db, userId, photo.stay_id);
  if (photo.status !== 'ready')
    throw new HttpError(404, 'NOT_FOUND', 'This photo is not available.');
  if (photo.removed_at) {
    const references = await db.query('SELECT photo_id FROM app.report_photos WHERE photo_id=$1', [
      photoId,
    ]);
    if (!references.rowCount) throw new HttpError(404, 'NOT_FOUND', 'This photo is not available.');
  }
  try {
    return await storage.get(variant === 'full' ? photo.storage_key : photo.preview_key);
  } catch {
    throw new HttpError(503, 'PHOTO_UNAVAILABLE', 'The photo could not be loaded. Try again.');
  }
}
