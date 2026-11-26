import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InspectionSummary, StaySetup } from '@rental-record/contracts';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('authentication and ownership', () => {
  it('requires a token and keeps unknown API paths out of the SPA fallback', async () => {
    await request(h.app).get('/api/stays').expect(401);
    await request(h.app).get('/api/stays').set('Authorization', 'Bearer forged-token').expect(401);
    const missing = await h.api('get', '/api/this-route-does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.type).toBe('application/json');
  });

  it('returns public configuration without server secrets', async () => {
    const result = await request(h.app).get('/api/config').expect(200);
    expect(result.body.authMode).toBe('demo');
    expect(JSON.stringify(result.body)).not.toMatch(
      /demoSecret|databaseUrl|serviceKey|DATABASE_URL/,
    );
    await request(h.app)
      .post('/api/demo/login')
      .send({ email: 'jordan@example.com', password: 'incorrect' })
      .expect(401);
  });

  it('isolates lists, details, edits, setup and inspections between two owners', async () => {
    const record = await h.makeRecord();
    const list = await h
      .api('get', `/api/stays?q=${encodeURIComponent(record.stay.title)}`, h.otherToken)
      .expect(200);
    expect(list.body.stays).toHaveLength(0);
    const paths = [
      `/api/stays/${record.stay.id}`,
      `/api/stays/${record.stay.id}/setup`,
      `/api/stays/${record.stay.id}/reports`,
      `/api/inspections/${record.inspectionId}`,
    ];
    for (const path of paths) await h.api('get', path, h.otherToken).expect(404);
    await h
      .api('patch', `/api/stays/${record.stay.id}`, h.otherToken)
      .send({ title: 'Taken over' })
      .expect(404);
    await h
      .api('delete', `/api/stays/${record.stay.id}`, h.otherToken)
      .send({ confirmationTitle: record.stay.title })
      .expect(404);
    expect((await h.api('get', `/api/stays/${record.stay.id}`)).body.stay.title).toBe(
      record.stay.title,
    );
  });

  it(`does not accept a client-selected owner`, async () => {
    const result = await h.api('post', '/api/stays').send({
      title: 'Owner field',
      city: 'Boston',
      state: 'MA',
      timeZone: 'America/New_York',
      roomTypes: ['other'],
      ownerId: randomUUID(),
    });
    expect(result.status).toBe(400);
  });
});

describe('record setup', () => {
  it.each([
    { state: 'ZZ' },
    { zipCode: '0213' },
    { timeZone: 'Not/A_Zone' },
    { title: '   ' },
    { roomTypes: [] },
  ])('rejects invalid record fields: %j', async (invalid) => {
    await h
      .api('post', '/api/stays')
      .send({
        title: 'Input check',
        city: 'Boston',
        state: 'MA',
        timeZone: 'America/New_York',
        roomTypes: ['other'],
        ...invalid,
      })
      .expect(400);
  });

  it('searches title/city and validates pagination without interpreting SQL fragments', async () => {
    const record = await h.makeRecord();
    const result = await h
      .api('get', `/api/stays?q=${encodeURIComponent(record.stay.title)}&page=1&pageSize=10`)
      .expect(200);
    expect(result.body.stays.map((stay: { id: string }) => stay.id)).toContain(record.stay.id);
    const malicious = await h.api('get', '/api/stays').query({ q: "' OR 1=1 --" }).expect(200);
    expect(malicious.body.stays).toHaveLength(0);
    await h.api('get', '/api/stays?page=0').expect(400);
    await h.api('get', '/api/stays?pageSize=51').expect(400);
  });

  it('adds, renames and removes rooms and items before the first report', async () => {
    const record = await h.makeRecord();
    const current = await h.getInspection(record.inspectionId);
    const room = await h
      .api('post', `/api/stays/${record.stay.id}/rooms`)
      .send({
        name: 'Storage',
        roomType: 'other',
        expectedEditVersion: current.inspection.editVersion,
      })
      .expect(201);
    const renamed = await h
      .api('patch', `/api/rooms/${room.body.id}`)
      .send({ name: 'Entry storage', expectedEditVersion: room.body.editVersion })
      .expect(200);
    const item = await h
      .api('post', `/api/rooms/${room.body.id}/items`)
      .send({ name: 'Shelf', expectedEditVersion: renamed.body.editVersion })
      .expect(201);
    const changed = await h
      .api('patch', `/api/items/${item.body.id}`)
      .send({ name: 'Top shelf', expectedEditVersion: item.body.editVersion })
      .expect(200);
    const setup = (await h.api('get', `/api/stays/${record.stay.id}/setup`).expect(200))
      .body as StaySetup;
    expect(
      setup.rooms
        .find((value) => value.id === room.body.id)
        ?.items.some((value) => value.name === 'Top shelf'),
    ).toBe(true);
    const removed = await h
      .api('delete', `/api/items/${item.body.id}`)
      .send({ expectedEditVersion: changed.body.editVersion })
      .expect(200);
    await h
      .api('delete', `/api/rooms/${room.body.id}`)
      .send({ expectedEditVersion: removed.body.editVersion })
      .expect(200);
    expect((await h.getInspection(record.inspectionId)).rooms).toHaveLength(1);
  });

  it('enforces same-stay relationships in the database', async () => {
    const first = await h.makeRecord();
    const second = await h.makeRecord();
    const secondView = await h.getInspection(second.inspectionId);
    await expect(
      h.db.query(
        "INSERT INTO app.observations (id, stay_id, inspection_id, item_id, condition, notes) VALUES ($1,$2,$3,$4,NULL,'')",
        [randomUUID(), first.stay.id, first.inspectionId, secondView.rooms[0]!.items[0]!.id],
      ),
    ).rejects.toThrow();
    expect((await h.getInspection(first.inspectionId)).rooms[0]!.items).toHaveLength(1);
  });
});

describe('inspection rules', () => {
  it('keeps an unrecorded note as a draft and blocks completion with an item reference', async () => {
    const record = await h.makeRecord();
    const view = await h.getInspection(record.inspectionId);
    const item = view.rooms[0]!.items[0]!;
    await h
      .api('patch', `/api/observations/${item.observation.id}`)
      .send({
        condition: null,
        notes: 'Check after the keys arrive.',
        expectedEditVersion: view.inspection.editVersion,
      })
      .expect(200);
    const saved = await h.getInspection(record.inspectionId);
    expect(saved.rooms[0]!.items[0]!.observation.notes).toBe('Check after the keys arrive.');
    const result = await h
      .api('post', `/api/inspections/${record.inspectionId}/complete`)
      .send({
        requestId: randomUUID(),
        expectedEditVersion: saved.inspection.editVersion,
      })
      .expect(422);
    expect(JSON.stringify(result.body.error.details)).toContain(item.id);
  });

  it.each(['issue', 'not_applicable', 'not_checked'])(
    'requires a description for %s',
    async (condition) => {
      const record = await h.makeRecord();
      const view = await h.getInspection(record.inspectionId);
      const result = await h
        .api('patch', `/api/observations/${view.rooms[0]!.items[0]!.observation.id}`)
        .send({
          condition,
          notes: '   ',
          expectedEditVersion: view.inspection.editVersion,
        });
      expect(result.status).toBe(422);
      expect(
        (await h.getInspection(record.inspectionId)).rooms[0]!.items[0]!.observation.condition,
      ).toBeNull();
    },
  );

  it('preserves the saved value when an older edit version arrives', async () => {
    const record = await h.makeRecord();
    const view = await h.getInspection(record.inspectionId);
    const path = `/api/observations/${view.rooms[0]!.items[0]!.observation.id}`;
    await h
      .api('patch', path)
      .send({
        condition: 'issue',
        notes: 'Small mark near the window.',
        expectedEditVersion: view.inspection.editVersion,
      })
      .expect(200);
    const stale = await h
      .api('patch', path)
      .send({ condition: 'no_issue', notes: '', expectedEditVersion: view.inspection.editVersion })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await h.getInspection(record.inspectionId)).rooms[0]!.items[0]!.observation.notes).toBe(
      'Small mark near the window.',
    );
  });

  it('allows a completed report to state that an item could not be inspected', async () => {
    const record = await h.makeRecord();
    await h.fillInspection(record, { condition: 'not_checked', notes: 'The room was locked.' });
    const report = await h.getReport((await h.complete(record.inspectionId)).reportId);
    expect(report.snapshot.current.rooms[0]!.items[0]!.condition).toBe('not_checked');
    expect(report.snapshot.current.rooms[0]!.items[0]!.notes).toBe('The room was locked.');
  });

  it('rejects impossible dates and does not complete a future inspection', async () => {
    const record = await h.makeRecord();
    const view = await h.getInspection(record.inspectionId);
    const invalid = await h.api('patch', `/api/inspections/${record.inspectionId}`).send({
      inspectionDate: '2025-02-30',
      expectedEditVersion: view.inspection.editVersion,
    });
    expect([400, 422]).toContain(invalid.status);
    const future = await h.fillInspection(record, { date: '2099-01-01' });
    await h
      .api('post', `/api/inspections/${record.inspectionId}/complete`)
      .send({
        requestId: randomUUID(),
        expectedEditVersion: future.inspection.editVersion,
      })
      .expect(422);
  });

  it('keeps a date-only value unchanged in a report', async () => {
    const record = await h.makeRecord();
    await h
      .api('patch', `/api/stays/${record.stay.id}`)
      .send({ timeZone: 'Pacific/Honolulu' })
      .expect(200);
    await h.fillInspection(record, { date: '2025-03-09' });
    const report = await h.getReport((await h.complete(record.inspectionId)).reportId);
    expect(report.snapshot.current.inspectionDate).toBe('2025-03-09');
    expect(report.snapshot.stay.timeZone).toBe('Pacific/Honolulu');
  });
});

describe('report versions and move-out', () => {
  it('returns one report for simultaneous identical completion requests', async () => {
    const record = await h.makeRecord();
    const view = await h.fillInspection(record);
    const body = { requestId: randomUUID(), expectedEditVersion: view.inspection.editVersion };
    const [first, second] = await Promise.all([
      h.api('post', `/api/inspections/${record.inspectionId}/complete`).send(body),
      h.api('post', `/api/inspections/${record.inspectionId}/complete`).send(body),
    ]);
    for (const response of [first, second])
      expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
    expect(first.body.reportId).toBe(second.body.reportId);
    const reports = await h.api('get', `/api/stays/${record.stay.id}/reports`).expect(200);
    expect(reports.body.reports).toHaveLength(1);
    await h
      .api('post', `/api/inspections/${record.inspectionId}/complete`)
      .send({ ...body, expectedEditVersion: body.expectedEditVersion + 1 })
      .expect(409);
  });

  it('preserves old text and freezes setup after a new version is opened', async () => {
    const record = await h.makeRecord();
    await h.fillInspection(record, { condition: 'issue', notes: 'Original note.' });
    const first = await h.complete(record.inspectionId);
    const oldReport = await h.getReport(first.reportId);
    const reopened = await h
      .api('post', `/api/inspections/${record.inspectionId}/reopen`)
      .send({ expectedEditVersion: first.editVersion })
      .expect(200);
    const view = await h.getInspection(record.inspectionId);
    await h
      .api('patch', `/api/observations/${view.rooms[0]!.items[0]!.observation.id}`)
      .send({
        condition: 'issue',
        notes: 'More precise note.',
        expectedEditVersion: reopened.body.editVersion,
      })
      .expect(200);
    await h.api('patch', `/api/stays/${record.stay.id}`).send({ city: 'Cambridge' }).expect(409);
    const current = await h.getInspection(record.inspectionId);
    await h
      .api('post', `/api/rooms/${current.rooms[0]!.id}/items`)
      .send({ name: 'New item', expectedEditVersion: current.inspection.editVersion })
      .expect(409);
    await h
      .api('patch', `/api/stays/${record.stay.id}`)
      .send({ title: 'A clearer record title' })
      .expect(200);
    const second = await h.complete(record.inspectionId);
    expect((await h.getReport(first.reportId)).snapshot).toEqual(oldReport.snapshot);
    const newReport = await h.getReport(second.reportId);
    expect(newReport.reportVersion).toBe(2);
    expect(newReport.snapshot.current.rooms[0]!.items[0]!.notes).toBe('More precise note.');
    await expect(
      h.db.query('UPDATE app.reports SET snapshot = $1 WHERE id = $2', [
        JSON.stringify({ changed: true }),
        first.reportId,
      ]),
    ).rejects.toThrow();
  });

  it('requires the current completed move-in version and creates blank observations with stable item IDs', async () => {
    const record = await h.makeRecord();
    await h.fillInspection(record, { condition: 'issue', notes: 'Existing scuff.' });
    const first = await h.complete(record.inspectionId);
    await h
      .api('post', `/api/inspections/${record.inspectionId}/reopen`)
      .send({ expectedEditVersion: first.editVersion })
      .expect(200);
    await h
      .api('post', `/api/stays/${record.stay.id}/move-out`)
      .send({ baselineReportId: first.reportId })
      .expect(409);
    const second = await h.complete(record.inspectionId);
    await h
      .api('post', `/api/stays/${record.stay.id}/move-out`)
      .send({ baselineReportId: first.reportId })
      .expect(409);
    const result = await h
      .api('post', `/api/stays/${record.stay.id}/move-out`)
      .send({ baselineReportId: second.reportId })
      .expect(201);
    const moveOut = result.body.inspection as InspectionSummary;
    const inView = await h.getInspection(record.inspectionId);
    const outView = await h.getInspection(moveOut.id);
    expect(outView.rooms[0]!.items[0]!.id).toBe(inView.rooms[0]!.items[0]!.id);
    expect(outView.rooms[0]!.items[0]!.observation).toMatchObject({
      condition: null,
      notes: '',
      photos: [],
    });
    expect(moveOut.baselineReportId).toBe(second.reportId);
    const retry = await h
      .api('post', `/api/stays/${record.stay.id}/move-out`)
      .send({ baselineReportId: second.reportId });
    expect([200, 201]).toContain(retry.status);
    expect(retry.body.inspection.id).toBe(moveOut.id);
    await h
      .api('post', `/api/inspections/${record.inspectionId}/reopen`)
      .send({ expectedEditVersion: inView.inspection.editVersion })
      .expect(409);
  });

  it('does not permit a move-out date before the baseline inspection', async () => {
    const record = await h.makeRecord();
    await h.fillInspection(record, { date: '2025-05-02' });
    const baseline = await h.complete(record.inspectionId);
    const created = await h
      .api('post', `/api/stays/${record.stay.id}/move-out`)
      .send({ baselineReportId: baseline.reportId })
      .expect(201);
    const moveOut = { stay: record.stay, inspectionId: created.body.inspection.id as string };
    const view = await h.fillInspection(moveOut, { date: '2025-05-01' });
    await h
      .api('post', `/api/inspections/${moveOut.inspectionId}/complete`)
      .send({ requestId: randomUUID(), expectedEditVersion: view.inspection.editVersion })
      .expect(422);
  });

  it('serializes move-out creation and move-in reopening', async () => {
    const record = await h.makeRecord();
    await h.fillInspection(record);
    const report = await h.complete(record.inspectionId);
    const [moveOut, reopen] = await Promise.all([
      h
        .api('post', `/api/stays/${record.stay.id}/move-out`)
        .send({ baselineReportId: report.reportId }),
      h
        .api('post', `/api/inspections/${record.inspectionId}/reopen`)
        .send({ expectedEditVersion: report.editVersion }),
    ]);
    expect(
      [moveOut.status, reopen.status].filter((value) => value >= 200 && value < 300),
    ).toHaveLength(1);
    expect([moveOut.status, reopen.status]).toContain(409);
  });

  it('archives only a completed stay and keeps the move-in lock after unarchiving', async () => {
    const record = await h.makeRecord();
    await h.api('post', `/api/stays/${record.stay.id}/archive`).expect(409);
    await h.fillInspection(record);
    const baseline = await h.complete(record.inspectionId);
    const out = await h
      .api('post', `/api/stays/${record.stay.id}/move-out`)
      .send({ baselineReportId: baseline.reportId })
      .expect(201);
    await h.fillInspection({ stay: record.stay, inspectionId: out.body.inspection.id });
    const report = await h.complete(out.body.inspection.id);
    await h.api('post', `/api/stays/${record.stay.id}/archive`).expect(200);
    await h
      .api('post', `/api/inspections/${out.body.inspection.id}/reopen`)
      .send({ expectedEditVersion: report.editVersion })
      .expect(409);
    const list = await h
      .api('get', '/api/stays')
      .query({ archived: 'true', q: record.stay.title })
      .expect(200);
    expect(list.body.stays.map((stay: { id: string }) => stay.id)).toContain(record.stay.id);
    await h.api('post', `/api/stays/${record.stay.id}/unarchive`).expect(200);
    await h
      .api('post', `/api/inspections/${out.body.inspection.id}/reopen`)
      .send({ expectedEditVersion: report.editVersion })
      .expect(200);
    await h
      .api('post', `/api/inspections/${record.inspectionId}/reopen`)
      .send({ expectedEditVersion: baseline.editVersion })
      .expect(409);
  });
});
