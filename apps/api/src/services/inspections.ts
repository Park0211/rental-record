import { randomUUID } from 'node:crypto';
import {
    observationSchema,
    observationProblem,
    todayInZone,
    type InspectionView,
    type InspectionSnapshot,
    type CompletionIssue,
    type ReportSnapshot,
    type Baseline,
} from '@rental-record/contracts';
import type { Database, SqlClient } from '../db.js';
import { HttpError } from '../errors.js';
import { parse, completeBody, inspectionBody, moveOutBody} from './validation.js';
import { roomsForStay, inspectionsForStay } from './stays.js';
import {
    bumpVersion,
    editable,
    inspectionView,
    lockInspection,
    ownedStay,
    photoView,
    stayView,
    type StayRow,
    type InspectionRow,
    type ObservationRow,
    type PhotoRow,
    type ReportRow, 
} from './rows.js';

async function baselineFor(
    tx: SqlClient,
    inspection: InspectionRow,
): Promise<Baseline | undefined> {
    if (inspection.kind === 'move_in') return undefined;
    const result = await tx.query<ReportRow>(
        "SELECT * FROM app.reports WHERE id=$1 AND stay_id=$2 AND kind = 'move_in'",
        [inspection.baseline_report_id, inspection.stay_id],
    );
    const report = result.rows[0];
    if (!report)
        throw new HttpError(409, 'BASELINE_UNAVAILABLE', 'The move-in report is not available.');
    return {
        reportId: report.id,
        reportVersion: report.report_version,
        inspection: report.snapshot.current,
    };
}

export function completionIssues(
    view: Pick<InspectionView, 'stay' | 'inspection' | 'rooms'>,
    baselineDate?: string | null,
): CompletionIssue[] {
    const issues: CompletionIssue[] = [];
    const day = view.inspection.inspectionDate;
    if (!day) issues.push({ code: 'DATE_REQUIRED', message: 'Choose the inspection date.'});
    else if (day > todayInZone(view.stay.timeZone))
        issues.push({ code: 'FUTURE_DATE', message: 'The inspection date cannot be in the future.' });
    if (day && baselineDate && day < baselineDate)
        issues.push({
            code: 'DATE_ORDER',
            message: 'Move-out cannot be dated before the baseline move-in inspection.',
    });
    if (view.rooms.length === 0)
        issues.push({ code: 'ROOM_REQUIRED', message: 'Add at least one room.'});
    for (const room of view.rooms) {
        if (room.items.length === 0)
            issues.push({
                code: 'ITEM_REQUIRED',
                roomId: room.id,
                message: `Add an item to ${room.name}.`,
        });
        for (const item of room.items) {
            const problem = observationProblem(item.observation.condition, item.observation.notes);
            if (problem)
                issues.push({
                    code: 'OBSERVATION_INCOMPLETE',
                    roomId: room.id,
                    itemId: item.id,
                    observationId: item.observation.id,
                    message: `${item.name}: ${problem}`,
                });
            if(item.observation.photos.some((photo) => photo.status !== 'ready')) {
                issues.push({
                    code: 'PHOTO_INCOMPLETE',
                    roomId: room.id,
                    itemId: item.id,
                    observationId: item.observation.id,
                    message: `${item.name}: finish or remove the unsuccessful photo uploads.`,
                });
            }
        }
    }
    return issues;
}

async function readInspection(
    tx: SqlClient,
    stay: StayRow,
    inspection: InspectionRow,
): Promise<InspectionView> {
    const rooms = await roomsForStay(tx, stay.id);
    const observations = await tx.query<ObservationRow>(
        'SELECT * FROM app.observations WHERE inspection_id=$1',
        [inspection.id],
    );
    const photos = await tx.query<PhotoRow>(
        `SELECT p.* FROM app.photos p JOIN app.observations o ON o.id=p.observation_id
        WHERE o.inspection_id=$1 AND p.removed_at IS NULL ORDER BY p.uploaded_at,p.id`,
        [inspection.id],
    );
    const summaries = await inspectionsForStay(tx, stay.id);
    const summary = summaries.find((value) => value.id === inspection.id)!;
    const result: InspectionView = {
        stay: stayView(stay),
        inspection: inspectionView(summary),
        editable: !stay.archived_at && inspection.status === 'draft',
        rooms: rooms.map((room) => ({
            ...room,
            items: room.items.map((item) =>{
                const row = observations.rows.find((observation) => observation.item_id === item.id);
                if (!row)
                    throw new HttpError(
                        500,
                        'INCOMPLETE_STRUCTURE',
                        'The inspection structure could not be loaded.',
                    );
                return {
                    ...item,
                    observation: {
                        id: row.id,
                        itemId: row.item_id,
                        condition: row.condition,
                        notes: row.notes,
                        photos: photos.rows.filter((photo) => photo.observation_id === row.id).map(photoView),
                    },
                };
            }),
        })),
        completionIssues: [],
    };
    const baseline = await baselineFor(tx, inspection);
    result.completionIssues = completionIssues(result, baseline?.inspection.inspectionDate);
    return result;
}

export function snapshotInspection(view: InspectionView): InspectionSnapshot {
    return {
        inspectionId: view.inspection.id,
        kind: view.inspection.kind,
        inspectionDate: view.inspection.inspectionDate,
        rooms: view.rooms.map((room) => ({
            id: room.id,
            name: room.name,
            roomType: room.roomType,
            items: room.items.map((item) => ({
                id: item.id,
                name: item.name,
                condition: item.observation.condition,
                notes: item.observation.notes,
                photos: item.observation.photos.map((photo) => ({ ...photo})),
            })),
        })),
    };
}

export async function getInspection(db: Database, userId: string, inspectionId: string) {
    const result = await db.query<InspectionRow>('SELECT * FROM app.inspections WHERE id=$1', [
        inspectionId,
    ]);
    if (!result.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'This inspection is not available.');
    const stay = await ownedStay(db, userId, result.rows[0].stay_id);
    return readInspection(db, stay, result.rows[0]);
}

export async function updateInspection(
    db: Database,
    userId: string,
    inspectionId: string,
    input: unknown,
) {
    const data = parse(inspectionBody, input, 422);
    return db.transaction(async (tx) => {
        const { stay, inspection } = await lockInspection(tx, userId, inspectionId);
        editable( stay, inspection, data.expectedEditVersion );
        await tx.query('UPDATE app.inspections SET inspection_date=$2 WHERE id=$1', [
            inspectionId,
            data.inspectionDate,
        ]);
        return { editVersion: await bumpVersion(tx, inspectionId) };
    });
}

export async function updateObservation(
    db: Database,
    userId: string,
    observationId: string,
    input: unknown,
) {
    const data = parse(observationSchema, input, 422);
    return db.transaction(async (tx) => {
        const found = await tx.query<ObservationRow>('SELECT * FROM app.observations WHERE id=$1', [
            observationId,
        ]);
        if (!found.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'This item is not available.');
        const { stay, inspection } = await lockInspection(tx, userId, found.rows[0].inspection_id);
        editable(stay, inspection, data.expectedEditVersion);
        const result = await tx.query(
            'UPDATE app.observations SET condition=$2,notes=$3,updated_at=now() WHERE id=$1',
            [observationId, data.condition, data.notes],
        );
        if (!result.rowCount) throw new HttpError(404, 'NOT_FOUND', 'This item is not available.');
        return { editVersion: await bumpVersion(tx, inspection.id) };
    });
}

export async function completeInspection(
    db:Database,
    userId: string,
    inspectionId: string,
    input: unknown,
) {
    const data = parse(completeBody, input);
    return db.transaction(async (tx) => {
        const { stay, inspection } = await lockInspection(tx, userId, inspectionId);
        // Look up the request under the same lock used to create a report.
        const previous = await tx.query<ReportRow>(
            'SELECT * FROM app.reports WHERE inspection_id=$1 AND request_id=$2',
            [inspectionId, data.requestId],
        );
        if (previous.rows[0]) {
            if (previous.rows[0].source_edit_version !== data.expectedEditVersion)
                throw new HttpError(
                  409,
                  'REQUEST_ID_REUSED',
                  'Use a new request ID for a different completion request.',
                );
            return { reportId: previous.rows[0].id, editVersion: inspection.edit_version }; 
        }
        editable(stay, inspection, data.expectedEditVersion);
        const view = await readInspection(tx, stay, inspection);
        if (view.completionIssues.length)
            throw new HttpError(
              422,
              'INSPECTION_INCOMPLETE',
              'Review the items below before completing this record.',
              { issues: view.completionIssues },
        );
        const next = await tx.query<{ version: number }>(
            'SELECT coalesce(max(report_version),0)+1 AS version FROM app.reports WHERE inspection_id=$1',
            [inspectionId],
        );
        const snapshot: ReportSnapshot = {
            schemaVersion: 1,
            stay: stayView(stay),
            capturedAt: new Date().toISOString(),
            current: snapshotInspection(view),
        };
        const baseline = await baselineFor(tx, inspection);
        if (baseline) snapshot.baseline = baseline;
        const reportId = randomUUID();
        await tx.query(
            `INSERT INTO app.reports (id,stay_id,inspection_id,kind,report_version,source_edit_version,request_id,snapshot,created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
            [
                reportId,
                stay.id,
                inspectionId,
                inspection.kind,
                next.rows[0]!.version,
                inspection.edit_version,
                data.requestId,
                JSON.stringify(snapshot),
                snapshot.capturedAt,
            ],
        );
        const snapshots = [
            snapshot.current,
            ...(snapshot.baseline ? [snapshot.baseline.inspection] : []),
        ];
        const photoIds = new Set(
            snapshots.flatMap((entry) =>
              entry.rooms.flatMap((room) =>
                room.items.flatMap((item) => item.photos.map((photo) => photo.id)),
            ),
        ),
    );
    for (const photoId of photoIds)
        await tx.query(
            'INSERT INTO app.report_photos (stay_id, report_id,photo_id) VALUES ($1,$2,$3)',
            [stay.id, reportId, photoId],
    );
    await tx.query("UPDATE app.inspections SET status='completed' WHERE id=$1", [inspectionId]);
    return { reportId, editVersion: await bumpVersion(tx,  inspectionId) };
    });
}

export async function reopenInspection(
    db: Database,
    userId: string,
    inspectionId: string,
    expectedEditVersion: number,
) {
    return db.transaction(async (tx) => {
        const { stay, inspection } = await lockInspection(tx, userId, inspectionId);
        if (stay.archived_at)
            throw new HttpError(409, 'RECORD_ARCHIVED', 'Unarchive this record before making changes.');
        if (inspection.edit_version !== expectedEditVersion)
            throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'This record was updated elsewhere. Reload it before making changes.',
        { currentEditVersion: inspection.edit_version },        
            );
        if (inspection.status !== 'completed')
            throw new HttpError(409, 'ALREADY_DRAFT', 'This inspection is already open for editing.');
        if (inspection.kind === 'move_in') {
            const result = await tx.query(
                "SELECT id FROM app.inspections WHERE stay_id=$1 AND kind='move_out'",
                [stay.id],
            );
            if (result.rowCount)
                throw new HttpError(
                  409,
                  'MOVE_IN_LOCKED',
                  'Move-in cannot be edited after move-out has started.',
            );
        }
        await tx.query("UPDATE app.inspections SET status='draft' WHERE id=$1", [inspectionId]);
        return { editVersion: await bumpVersion(tx, inspectionId) };    
    });
}

export async function startMoveOut(db: Database, userId: string, stayId: string, input: unknown) {
    const data = parse(moveOutBody, input);
    return db.transaction(async (tx) => {
        const stay = await ownedStay(tx, userId,stayId, true);
        const existing = await tx.query<InspectionRow>(
            "SELECT * FROM app.inspections WHERE stay_id=$1 AND kind='move_out' FOR UPDATE",
            [stayId],
        );
        if (existing.rows[0]) {
            if (existing.rows[0].baseline_report_id !== data.baselineReportId)
                throw new HttpError(
                  409,
                  'BASELINE_FIXED',
                  'This move-out inspection already has a baseline report.',  
                );
            const summaries = await inspectionsForStay(tx, stayId);
            return {
                inspection: inspectionView(
                    summaries.find((inspection) => inspection.id === existing.rows[0]!.id)!,
                ),
            };
        }
        if (stay.archived_at)
            throw new HttpError(409, 'RECORD_ARCHIVED', 'Unarchive this record before making changes.');
        const moveIn = await tx.query<InspectionRow>(
            "SELECT * FROM app.inspections WHERE stay_id=$1 AND kind='move_in' FOR UPDATE",
            [stayId],
        );
        if (moveIn.rows[0]?.status !== 'completed')
            throw new HttpError(
                409,
                'MOVE_IN_INCOMPLETE',
                'Complete the current move-in record before starting move-out.',
            );
        const reports = await tx.query<ReportRow>(
            "SELECT * FROM app.reports WHERE stay_id=$1 AND kind='move_in' ORDER BY report_version DESC LIMIT 1",
            [stayId],
        );
        if (reports.rows[0]?.id !==data.baselineReportId)
            throw new HttpError(409, 'BASELINE_OUTDATED', 'Choose the latest completed move-in report.');
        const id = randomUUID();
        const result = await tx.query<InspectionRow>(
            `INSERT INTO app.inspections (id,stay_id,kind,baseline_report_id,inspection_date)
            VALUES ($1,$2,'move_out',$3,$4) RETURNING *`,
            [id, stayId, data.baselineReportId, data.inspectionDate ?? null],
        );
        const items = await tx.query<{ id: string }>(
            'SELECT id FROM app.check_items WHERE stay_id=$1',
            [stayId],
        );
        for (const item of items.rows)
            await tx.query(
                'INSERT INTO app.observations (id,stay_id,inspection_id,item_id) VALUES ($1,$2,$3,$4)',
                [randomUUID(), stayId, id, item.id],
            );
        await tx.query('UPDATE app.stays SET updated_at=now() WHERE id=$1', [stayId]);
        return { inspection: inspectionView(result.rows[0]!) };
    });
}

export async function getComparison(db:Database, userId: string, stayId: string) {
    const stay = await ownedStay(db, userId, stayId);
    const result = await db.query<InspectionRow>(
        "SELECT * FROM app.inspections WHERE stay_id=$1 AND kind='move_out'",
        [stayId],
    );
    if (!result.rows[0])
        throw new HttpError(
            409,
            'MOVE_OUT_NOT_STARTED',
            'Start a move-out inspection to compare records.',
        );
    const view = await readInspection(db, stay, result.rows[0]);
    return {
        stay: stayView(stay),
        baseline: (await baselineFor(db, result.rows[0]))!,
        current: snapshotInspection(view),
    };
}