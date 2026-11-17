import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import type { PhotoStorage } from '../storage.js';
import { HttpError } from '../errors.js';
import {
  ownedStay,
  reportSummary,
  reportView,
  shareView,
  type PhotoRow,
  type ReportRow,
  type ShareRow,
} from './rows.js';

export async function getReport(db: Database, userId: string, reportId: string) {
  const result = await db.query<ReportRow>('SELECT * FROM app.reports WHERE id=$1', [reportId]);
  const report = result.rows[0];
  if (!report) throw new HttpError(404, 'NOT_FOUND', 'This report is not available.');
  await ownedStay(db, userId, report.stay_id);
  return reportView(report);
}

export async function listReports(db: Database, userId: string, stayId: string) {
  await ownedStay(db, userId, stayId);
  const result = await db.query<ReportRow>(
    'SELECT * FROM app.reports WHERE stay_id=$1 ORDER BY created_at DESC, report_version DESC',
    [stayId],
  );
  return { reports: result.rows.map(reportSummary) };
}

export async function createShare(
  db: Database,
  userId: string,
  reportId: string,
  expiresInDays: 1 | 7 | 30,
  appUrl: string,
) {
  return db.transaction(async (tx) => {
    const reports = await tx.query<ReportRow>('SELECT * FROM app.reports WHERE id=$1', [reportId]);
    const report = reports.rows[0];
    if (!report) throw new HttpError(404, 'NOT_FOUND', 'This report is not available.');
    await ownedStay(tx, userId, report.stay_id, true);
    await tx.query(
      'UPDATE app.share_links SET revoked_at=now() WHERE report_id=$1 AND revoked_at IS NULL',
      [reportId],
    );
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
    const result = await tx.query<ShareRow>(
      `INSERT INTO app.share_links (id,stay_id,report_id,token_hash,expires_at)
            VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [randomUUID(), report.stay_id, reportId, tokenHash, expiresAt],
    );
    return { shareLink: shareView(result.rows[0]!), token, url: `${appUrl}/shared/${token}` };
  });
}

export async function listShares(db: Database, userId: string, reportId: string) {
  await getReport(db, userId, reportId);
  const result = await db.query<ShareRow>(
    'SELECT * FROM app.share_links WHERE report_id=$1 ORDER BY created_at DESC',
    [reportId],
  );
  return { shareLinks: result.rows.map(shareView) };
}

export async function revokeShare(db: Database, userId: string, shareId: string) {
  await db.transaction(async (tx) => {
    const result = await tx.query<ShareRow>('SELECT * FROM app.share_links WHERE id=$1', [shareId]);
    if (!result.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'This share link is not available.');
    await ownedStay(tx, userId, result.rows[0].stay_id, true);
    await tx.query('UPDATE app.share_links SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1', [
      shareId,
    ]);
  });
}

async function sharedReportRow(db: Database, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new HttpError(404, 'LINK_UNAVAILABLE', 'This link is no longer available.');
  const hash = createHash('sha256').update(token).digest('hex');
  const result = await db.query<ReportRow>(
    `SELECT r.* FROM app.share_links l JOIN app.reports r ON r.id=l.report_id
        JOIN app.stays s ON s.id=l.stay_id WHERE l.token_hash=$1 AND l.revoked_at IS NULL
        AND l.expired_at>now() AND s.deleted_at IS NULL`,
    [hash],
  );
  if (!result.rows[0])
    throw new HttpError(404, 'LINK_UNAVAILABLE', 'This link is no longer available.');
  return result.rows[0];
}

export async function getSharedReport(db: Database, token: string) {
  return reportView(await sharedReportRow(db, token));
}

export async function getSharedPhoto(
  db: Database,
  storage: PhotoStorage,
  token: string,
  photoId: string,
  variant: 'preview' | 'full',
) {
  const report = await sharedReportRow(db, token);
  const result = await db.query<PhotoRow>(
    `SELECT p.* FROM app.report_photos rp JOIN app.photos p ON p.id=rp.photo_id
        WHERE rp.report_id=$1 AND rp.photo_id=$2 AND p.status='ready'`,
    [report.id, photoId],
  );
  if (!result.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'This photo is not available.');
  const photo = result.rows[0];
  let bytes: Buffer;
  try {
    bytes = await storage.get(variant === 'full' ? photo.storage_key : photo.preview_key);
  } catch {
    throw new HttpError(503, 'PHOTO_UNAVAILABLE', 'The photo could not be loaded. Try again.');
  }
  // A slow storage request should not outlive a revovation unnoticed.
  await sharedReportRow(db, token);
  return bytes;
}
