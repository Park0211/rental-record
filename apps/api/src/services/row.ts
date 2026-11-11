import type { SqlClient } from '../db';
import { HttpError } from '../errors.js';

export type DbTime = Date | string;
export type Condition = 'no_issue' | 'issue' | 'not_applicable' | 'not_checked' | null;
export type RoomType =
  'living_room' | 'bedroom' | 'kitchen' | 'bathroom' | 'hallway' | 'laundry' | 'other';
export type InspectionKind = 'move_in' | 'move_out';

export interface StayRow {
  id: string;
  owner_id: string;
  title: string;
  city: string;
  state: string;
  street: string;
  unit: string;
  zip_code: string;
  time_zone: string;
  archived_at: DbTime | null;
  deleted_at: DbTime | null;
  created_at: DbTime;
  updated_at: DbTime;
}
export interface RoomRow {
  id: string;
  stay_id: string;
  name: string;
  room_type: RoomType;
  sort_order: number;
}
export interface itemRow {
  id: string;
  stay_id: string;
  room_id: string;
  name: string;
  sort_order: number;
}
export interface InspectionRow {
  id: string;
  stay_id: string;
  kind: InspectionKind;
  status: 'draft' | 'completed';
  inspection_date: DbTime | null;
  edit_version: number;
  baseline_report_id: string | null;
  created_at: DbTime;
  updated_at: DbTime;
  report_count?: number | string;
  latest_report_id?: string | null;
}
export interface ObservationRow {
  id: string;
  stay_id: string;
  inspection_id: string;
  item_id: string;
  condition: Condition;
  notes: string;
  updated_at: DbTime;
}
export interface PhotoRow {
  id: string;
  stay_id: string;
  observation_id: string;
  client_upload_id: string;
  source_sha256: string;
  storage_key: string;
  preview_key: string;
  status: 'pending' | 'ready' | 'failed';
  stored_mime: string;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  uploaded_at: DbTime;
  removed_at: DbTime | null;
  last_error: string | null;
}
export interface ReportRow {
  id: string;
  stay_id: string;
  inspection_id: string;
  kind: InspectionKind;
  report_version: number;
  source_edit_version: number;
  request_id: string;
  snapshot: import('@rental-record/contracts').ReportSnapshot;
  created_at: DbTime;
}
export interface ShareRow {
  id: string;
  stay_id: string;
  report_id: string;
  token_hash: string;
  created_at: DbTime;
  expires_at: DbTime;
  revoked_at: DbTime | null;
}

export const iso = (value: DbTime) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
export const nullableIso = (value: DbTime | null) => (value === null ? null : iso(value));
export const dateOnly = (value: DbTime | null) =>
  value === null ? null : (value instanceof Date ? value.toISOString() : value).slice(0, 10);

export function stayView(row: StayRow) {
  return {
    id: row.id,
    title: row.title,
    city: row.city,
    state: row.state,
    street: row.street,
    unit: row.unit,
    zipCode: row.zip_code,
    timeZone: row.time_zone,
    archivedAt: nullableIso(row.archived_at),
    deletedAt: nullableIso(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
export function inspectionView(row: InspectionRow) {
  return {
    id: row.id,
    stayId: row.stay_id,
    kind: row.kind,
    status: row.status,
    inspectionDate: dateOnly(row.inspection_date),
    editVersion: row.edit_version,
    baselineReportId: row.baseline_report_id,
    reportCount: Number(row.report_count ?? 0),
    latestReportId: row.baseline_report_id ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
export function itemView(row: itemRow) {
  return {
    id: row.id,
    stayId: row.stay_id,
    roomId: row.room_id,
    name: row.name,
    sortOrder: row.sort_order,
  };
}
export function photoView(row: PhotoRow) {
  return {
    id: row.id,
    clientUploadId: row.client_upload_id,
    status: row.status,
    storedMime: row.stored_mime,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
    uploadedAt: iso(row.uploaded_at),
    lastError: row.last_error,
  };
}
export function reportView(row: ReportRow) {
  return { ...reportSummary(row), snapshot: row.snapshot };
}
export function reportSummary(row: ReportRow) {
  return {
    id: row.id,
    stayId: row.stay_id,
    inspectionId: row.inspection_id,
    kind: row.kind,
    reportVersion: row.report_version,
    createdAt: iso(row.created_at),
  };
}
export function shareView(row: ShareRow) {
  return {
    id: row.id,
    reportId: row.report_id,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
  };
}

export async function ownedStay(
  tx: SqlClient,
  userId: string,
  stayId: string,
  lock = false,
  allowDeleted = false,
) {
  const { rows } = await tx.query<StayRow>(
    `SELECT * FROM app.stays WHERE id = $1 AND owner_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [stayId, userId],
  );
  const stay = rows[0];
  if (!stay || (stay.deleted_at && !allowDeleted))
    throw new HttpError(404, 'NOT_FOUND', 'This record is not available.');
  return stay;
}

export async function lockInspection(tx: SqlClient, userId: string, inspectionId: string) {
  const found = await tx.query<{ stay_id: string }>(
    'SELECT stay_id FROM app.inspections WHERE id = $1',
    [inspectionId],
  );
  if (!found.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'This inspection is not available.');
  const stay = await ownedStay(tx, userId, found.rows[0].stay_id, true);
  const result = await tx.query<InspectionRow>(
    'SELECT * FROM app.inspections WHERE id = $1 AND stay_id = $2 FOR UPDATE',
    [inspectionId, stay.id],
  );
  if (!result.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'This inspection is not available.');
  return { stay, inspection: result.rows[0] };
}

export function editable(stay: StayRow, inspection: InspectionRow, expectedEditVersion: number) {
  if (stay.archived_at)
    throw new HttpError(409, 'RECORD_ARCHIVED', 'Unarchive this record before making changes.');
  if (inspection.status !== 'draft')
    throw new HttpError(409, 'RECORD_COMPLETED', 'Open a new version before making changes.');
  if (inspection.edit_version !== expectedEditVersion) {
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This record was updated elsewhere. Your changes have not been saved.',
      { currentEditVersion: inspection.edit_version },
    );
  }
}

export async function bumpVersion(tx: SqlClient, inspectionId: string) {
  const result = await tx.query<{ edit_version: number }>(
    'UPDATE app.inspections SET edit_version = edit_version + 1, updated_at = now() WHERE id = $1 RETURNING edit_version',
    [inspectionId],
  );
  await tx.query(
    'UPDATE app.stays SET updated_at = now() WHERE id = (SELECT stay_id FROM app.inspections WHERE id = $1)',
    [inspectionId],
  );
  return result.rows[0]!.edit_version;
}

export async function structureEditable(
  tx: SqlClient,
  stay: StayRow,
  inspection: InspectionRow,
  expectedEditVersion: number,
) {
  editable(stay, inspection, expectedEditVersion);
  const result = await tx.query<{ count: string }>(
    'SELECT count(*) AS count FROM app.reports WHERE stay_id = $1',
    [stay.id],
  );
  if (Number(result.rows[0]!.count))
    throw new HttpError(
      409,
      'STRUCTURE_FROZEN',
      'Rooms and items are fixed after the first report.',
    );
}
