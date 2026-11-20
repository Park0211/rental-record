import type { Database } from '../db.js';
import type { PhotoStorage } from '../storage.js';
import { HttpError } from '../errors.js';
import { bumpVersion, ownedStay, type PhotoRow, type StayRow, type InspectionRow } from './rows';

interface Dependencies {
  db: Database;
  storage: PhotoStorage;
}

export async function purgeDeletedStay({ db, storage }: Dependencies, stayId: string) {
  const pending = await db.query<StayRow>(
    'SELECT * FROM app.stays WHERE id=$1 AND deleted_at IS NOT NULL',
    [stayId],
  );
  if (!pending.rows[0]) return;
  const photos = await db.query<PhotoRow>('SELECT * FROM app.photos WHERE stay_id=$1', [stayId]);
  const keys = photos.rows.flatMap((photo) => [photo.storage_key, photo.preview_key]);
  if (keys.length) await storage.remove(keys);
  await db.transaction(async (tx) => {
    const found = await tx.query<StayRow>('SELECT * FROM app.stays WHERE id=$1 FOR UPDATE', [
      stayId,
    ]);
    if (!found.rows[0]?.deleted_at) return;
    await tx.query('DELETE FROM app.share_links WHERE stay_id=$1', [stayId]);
    await tx.query('DELETE FROM app.report_photos WHERE stay_id=$1', [stayId]);
    // Move-out holds a foreign key to its move-in baseline, so it is removed first.
    for (const kind of ['move_out', 'move_in']) {
      await tx.query('DELETE FROM app.reports WHERE stay_id=$1 AND kind=$2', [stayId, kind]);
      await tx.query(
        `DELETE FROM app.photos WHERE observation_id IN
                (SELECT o.id FROM app.observations o JOIN app.inspections i ON i.id=o.inspection_id WHERE i.stay_id=$1 AND i.kind=$2)`,
        [stayId, kind],
      );
      await tx.query(
        `DELETE FROM app.observations WHERE inspection_id IN (SELECT id FROM app.inspections WHERE stay_id=$1 AND kind=$2)`,
        [stayId, kind],
      );
      await tx.query('DELETE FROM app.inspections WHERE stay_id=$1 AND kind=$2', [stayId, kind]);
    }
    await tx.query('DELETE FROM app.check_items WHERE stay_id=$1', [stayId]);
    await tx.query('DELETE FROM app.rooms WHERE stay_id=$1', [stayId]);
    await tx.query('DELETE FROM app.stays WHERE id=$1', [stayId]);
  });
}

export async function deleteStay(
  deps: Dependencies,
  userId: string,
  stayId: string,
  confirmationTitle: string,
) {
  await deps.db.transaction(async (tx) => {
    const stay = await ownedStay(tx, userId, stayId, true, true);
    if (stay.title !== confirmationTitle)
      throw new HttpError(
        422,
        'CONFIRMATION_MISMATCH',
        'Enter the record name exactly to delete it.',
      );
    await tx.query(
      'UPDATE app.stays SET deleted_at=coalesce(deleted_at,now()),updated_at=now() WHERE id=$1',
      [stayId],
    );
    await tx.query(
      'UPDATE app.share_links SET revoked_at=coalesce(revoked_at,now()) WHERE stay_id=$1',
      [stayId],
    );
  });
  try {
    await purgeDeletedStay(deps, stayId);
    return { deletionPending: false };
  } catch {
    return { deletionPending: true };
  }
}

export async function cleanupResources(deps: Dependencies) {
  const { db, storage } = deps;
  const summary = {
    interruptedUploads: 0,
    removedPhotoFiles: 0,
    deletedStays: 0,
    orphanFiles: 0,
    failures: 0,
  };
  const pending = await db.query<{
    id: string;
    stay_id: string;
  }>(`SELECT DISTINCT i.id, i.stay_id FROM app.photos p
        JOIN app.observations o ON o.id=p.observation_id JOIN app.inspections i ON i.id=o.inspection_id
        WHERE p.status='pending' AND p.removed_at IS NULL AND p.uploaded_at < now()-interval '10 minutes'`);
  for (const candidate of pending.rows) {
    const changed = await db.transaction(async (tx) => {
      const stays = await tx.query<StayRow>('SELECT * FROM app.stays WHERE id=$1 FOR UPDATE', [
        candidate.stay_id,
      ]);
      if (!stays.rows[0] || stays.rows[0].deleted_at) return 0;
      const inspections = await tx.query<InspectionRow>(
        'SELECT * FROM app.inspections WHERE id=$1 FOR UPDATE',
        [candidate.id],
      );
      if (!inspections.rows[0]) return 0;
      const result = await tx.query(
        `UPDATE app.photos SET status='failed', last_error='The upload was interrupted. Retry or remove it.'
                WHERE observation_id IN (SELECT id FROM app.observations WHERE inspection_id=$1)
                AND status='pending' AND removed_at IS NULL AND uploaded_at < now()-interval '10 minutes'`,
        [candidate.id],
      );
      if (result.rowCount) await bumpVersion(tx, candidate.id);
      return result.rowCount;
    });
    summary.interruptedUploads += changed;
  }
  const photos =
    await db.query<PhotoRow>(`SELECT p.* FROM app.photos p WHERE (p.removed_at IS NOT NULL OR p.status='failed')
        AND NOT EXISTS (SELECT FROM app.report_photos rp WHERE rp.photo_id=p.id)`);
  for (const photo of photos.rows) {
    try {
      await storage.remove([photo.storage_key, photo.preview_key]);
      summary.removedPhotoFiles += 2;
    } catch {
      summary.failures += 1;
    }
  }
  const stays = await db.query<{ id: string }>(
    'SELECT id FROM app.stays WHERE deleted_at IS NOT NULL',
  );
  for (const stay of stays.rows) {
    try {
      await purgeDeletedStay(deps, stay.id);
      summary.deletedStays += 1;
    } catch {
      summary.failures += 1;
    }
  }
  try {
    const files = await storage.list();
    const current = await db.query<{ storage_key: string; preview_key: string }>(
      'SELECT storage_key,preview_key FROM app.photos',
    );
    const known = new Set(current.rows.flatMap((row) => [row.storage_key, row.preview_key]));
    const cutoff = Date.now() - 86400000;
    const orphaned = files.filter(
      (file) => !known.has(file.key) && new Date(file.createdAt).getTime() < cutoff,
    );
    if (orphaned.length) await storage.remove(orphaned.map((file) => file.key));
    summary.orphanFiles = orphaned.length;
  } catch {
    summary.failures += 1;
  }
  return summary;
}
