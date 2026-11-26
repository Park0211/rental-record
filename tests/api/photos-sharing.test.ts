import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { cleanupResources } from '../../apps/api/src/services/cleanup.js';
import {
  binaryParser,
  createHarness,
  expectUploadSuccess,
  imageBuffer,
  type Harness,
} from './helpers.js';

let h: Harness;
let jpeg: Buffer;
beforeAll(async () => {
  h = await createHarness();
  jpeg = await imageBuffer();
});
afterEach(() => {
  if (h) {
    h.faults.put = false;
    h.faults.remove = false;
  }
});
afterAll(async () => {
  await h?.close();
});

async function readyReport() {
  const record = await h.makeRecord();
  await h.fillInspection(record, { condition: 'issue', notes: 'A mark beside the door.' });
  const upload = expectUploadSuccess(await h.addPhoto(record.inspectionId, jpeg));
  const report = await h.complete(record.inspectionId);
  return { ...record, ...report, photo: upload.photo };
}

async function share(reportId: string) {
  const response = await h
    .api('post', `/api/reports/${reportId}/share-links`)
    .send({ expiresInDays: 7 })
    .expect(201);
  return response.body as { shareLink: { id: string }; token: string; url: string };
}

describe('photo uploads', () => {
  it('stores private WebP copies, removes metadata and respects the two size limits', async () => {
    const record = await h.makeRecord();
    const source = await sharp({
      create: { width: 3000, height: 1600, channels: 3, background: '#c3c6c8' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const uploaded = expectUploadSuccess(await h.addPhoto(record.inspectionId, source));
    expect(uploaded.photo.storedMime).toBe('image/webp');
    expect(JSON.stringify(uploaded.photo)).not.toMatch(
      /storage_key|storageKey|preview_key|source_sha256/,
    );
    const full = await h
      .api('get', `/api/photos/${uploaded.photo.id}/content?variant=full`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    const preview = await h
      .api('get', `/api/photos/${uploaded.photo.id}/content?variant=preview`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    const fullMetadata = await sharp(full.body as Buffer).metadata();
    const previewMetadata = await sharp(preview.body as Buffer).metadata();
    expect(fullMetadata.format).toBe('webp');
    expect(Math.max(fullMetadata.width!, fullMetadata.height!)).toBeLessThanOrEqual(2400);
    expect(Math.max(previewMetadata.width!, previewMetadata.height!)).toBeLessThanOrEqual(1200);
    expect(fullMetadata.height!).toBeGreaterThan(fullMetadata.width!);
    expect(fullMetadata.exif).toBeUndefined();
    expect(fullMetadata.orientation).toBeUndefined();
    expect(full.headers['cache-control']).toContain('no-store');
    await request(h.app).get(`/api/photos/${uploaded.photo.id}/content`).expect(401);
    await h.api('get', `/api/photos/${uploaded.photo.id}/content`, h.otherToken).expect(404);
  });

  it('rejects an oversized file before treating it as a saved image', async () => {
    const record = await h.makeRecord();
    const result = await h.addPhoto(record.inspectionId, Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(result.status).toBe(413);
    expect(
      (await h.getInspection(record.inspectionId)).rooms[0]!.items[0]!.observation.photos,
    ).toHaveLength(0);
  });

  it('rejects disguised files and leaves a removable failed upload', async () => {
    const record = await h.makeRecord();
    await h.fillInspection(record);
    const result = await h.addPhoto(
      record.inspectionId,
      Buffer.from('not an image'),
      randomUUID(),
      'image/jpeg',
      'photo.jpg',
    );
    expect(result.status).toBe(415);
    const current = await h.getInspection(record.inspectionId);
    expect(current.rooms[0]!.items[0]!.observation.photos[0]!.status).toBe('failed');
    await h
      .api('post', `/api/inspections/${record.inspectionId}/complete`)
      .send({ requestId: randomUUID(), expectedEditVersion: current.inspection.editVersion })
      .expect(422);
  });

  it('rejects SVG even when it is a well-formed image', async () => {
    const record = await h.makeRecord();
    const result = await h.addPhoto(
      record.inspectionId,
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" /></svg>',
      ),
      randomUUID(),
      'image/svg+xml',
      'photo.svg',
    );
    expect(result.status).toBe(415);
  });

  it('returns the existing upload when a reponse is lost, even with the old edit version', async () => {
    const record = await h.makeRecord();
    const view = await h.getInspection(record.inspectionId);
    const clientUploadId = randomUUID();
    const observationId = view.rooms[0]!.items[0]!.observation.id;
    const send = (file = jpeg) =>
      h
        .api('post', `/api/observations/${observationId}/photos`)
        .field('clientUploadId', clientUploadId)
        .field('expectedEditVersion', String(view.inspection.editVersion))
        .attach('file', file, { filename: 'wall.jpg', contentType: 'image/jpeg' });
    const first = expectUploadSuccess(await send());
    const retry = expectUploadSuccess(await send());
    expect(retry.photo.id).toBe(first.photo.id);
    expect(
      (await h.getInspection(record.inspectionId)).rooms[0]!.items[0]!.observation.photos,
    ).toHaveLength(1);
    await send(await imageBuffer(80, 60, '#ffd3a1')).expect(409);
  });

  it('reserves only one photo for concurrent requests with the same upload ID', async () => {
    const record = await h.makeRecord();
    const view = await h.getInspection(record.inspectionId);
    const clientUploadId = randomUUID();
    const send = () =>
      h
        .api('post', `/api/observations/${view.rooms[0]!.items[0]!.observation.id}/photos`)
        .field('clientUploadId', clientUploadId)
        .field('expectedEditVersion', String(view.inspection.editVersion))
        .attach('file', jpeg, { filename: 'wall.jpg', contentType: 'image/jpeg' });
    const responses = await Promise.all([send(), send()]);
    for (const response of responses)
      expect([200, 201, 202], JSON.stringify(response.body)).toContain(response.status);
    expect(responses[0]!.body.photo.id).toBe(responses[1]!.body.photo.id);
    const photos = (await h.getInspection(record.inspectionId)).rooms[0]!.items[0]!.observation
      .photos;
    expect(photos).toHaveLength(1);
    expect(photos[0]!.status).toBe('ready');
  });

  it('counts failures toward the per-item limit and frees a slot before retrying', async () => {
    const record = await h.makeRecord();
    await h.fillInspection(record);
    for (let index = 0; index < 4; index++)
      expectUploadSuccess(await h.addPhoto(record.inspectionId, jpeg));
    h.faults.put = true;
    const failed = await h.addPhoto(record.inspectionId, jpeg);
    expect(failed.status).toBe(503);
    h.faults.put = false;
    const blocked = await h.addPhoto(record.inspectionId, jpeg);
    expect([409, 422]).toContain(blocked.status);
    let view = await h.getInspection(record.inspectionId);
    const failedPhoto = view.rooms[0]!.items[0]!.observation.photos.find(
      (photo) => photo.status === 'failed',
    )!;
    expect(failedPhoto).toBeDefined();
    await h
      .api('delete', `/api/photos/${failedPhoto.id}`)
      .send({ expectedEditVersion: view.inspection.editVersion })
      .expect(200);
    expectUploadSuccess(await h.addPhoto(record.inspectionId, jpeg));
    view = await h.getInspection(record.inspectionId);
    expect(view.rooms[0]!.items[0]!.observation.photos).toHaveLength(5);
    expect(
      view.rooms[0]!.items[0]!.observation.photos.every((photo) => photo.status === 'ready'),
    ).toBe(true);
    expect((await h.complete(record.inspectionId)).reportId).toBeTruthy();
  });

  it('enforces the inspection-wide limit across different items', async () => {
    const record = await h.makeRecord();
    let view = await h.getInspection(record.inspectionId);
    for (let index = 1; index < 9; index++) {
      await h
        .api('post', `/api/rooms/${view.rooms[0]!.id}/items`)
        .send({ name: `item ${index}`, expectedEditVersion: view.inspection.editVersion })
        .expect(201);
      view = await h.getInspection(record.inspectionId);
    }
    let version = view.inspection.editVersion;
    for (const item of view.rooms[0]!.items.slice(0, 8)) {
      for (let photo = 0; photo < 5; photo++) {
        const result = expectUploadSuccess(
          await h
            .api('post', `/api/observations/${item.observation.id}/photos`)
            .field('clientUploadId', randomUUID())
            .field('expectedEditVersion', String(version))
            .attach('file', jpeg, { filename: 'wall.jpg', contentType: 'image/jpeg' }),
        );
        version = result.editVersion;
      }
    }
    const rejected = await h
      .api('post', `/api/observations/${view.rooms[0]!.items[8]!.observation.id}/photos`)
      .field('clientUploadId', randomUUID())
      .field('expectedEditVersion', String(version))
      .attach('file', jpeg, { filename: 'wall.jpg', contentType: 'image/jpeg' });
    expect([409, 422]).toContain(rejected.status);
    expect(
      (await h.getInspection(record.inspectionId)).rooms[0]!.items.flatMap(
        (item) => item.observation.photos,
      ),
    ).toHaveLength(40);
  }, 60_000);
});

describe('report photos and read-only sharing', () => {
  it('keeps an old photo available after it is removed from a new draft', async () => {
    const record = await readyReport();
    const before = await h.getReport(record.reportId);
    const reopened = await h
      .api('post', `/api/inspections/${record.inspectionId}/reopen`)
      .send({ expectedEditVersion: record.editVersion })
      .expect(200);
    await h
      .api('delete', `/api/photos/${record.photo.id}`)
      .send({ expectedEditVersion: reopened.body.editVersion })
      .expect(200);
    expect(
      (await h.getInspection(record.inspectionId)).rooms[0]!.items[0]!.observation.photos,
    ).toHaveLength(0);
    await cleanupResources({ db: h.db, storage: h.storage });
    await h.api('get', `/api/photos/${record.photo.id}/content`).expect(200);
    expect((await h.getReport(record.reportId)).snapshot).toEqual(before.snapshot);
    const second = await h.complete(record.inspectionId);
    expect(
      (await h.getReport(second.reportId)).snapshot.current.rooms[0]!.items[0]!.photos,
    ).toHaveLength(0);
  });

  it('shares one fixed version, stores only the token hash, and checks photo membership', async () => {
    const record = await readyReport();
    const link = await share(record.reportId);
    const published = await request(h.app).get(`/api/shared/${link.token}`).expect(200);
    expect(published.body.id).toBe(record.reportId);
    expect(published.headers['cache-control']).toContain('no-store');
    expect(published.headers['referrer-policy']).toBe('no-referrer');
    const row = await h.db.query<{ token_hash: string }>(
      'SELECT token_hash FROM app.share_links WHERE id = $1',
      [link.shareLink.id],
    );
    expect(row.rows[0]!.token_hash).toBe(createHash('sha256').update(link.token).digest('hex'));
    const listed = await h.api('get', `/api/reports/${record.reportId}/share-links`).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(link.token);
    expect(JSON.stringify(listed.body)).not.toContain(row.rows[0]!.token_hash);
    await request(h.app).get(`/api/shared/${link.token}/photos/${record.photo.id}`).expect(200);

    await h
      .api('post', `/api/inspections/${record.inspectionId}/reopen`)
      .send({ expectedEditVersion: record.editVersion })
      .expect(200);
    const secondPhoto = expectUploadSuccess(await h.addPhoto(record.inspectionId, jpeg)).photo;
    const secondReport = await h.complete(record.inspectionId);
    expect(secondReport.reportId).not.toBe(record.reportId);
    expect((await request(h.app).get(`/api/shared/${link.token}`).expect(200)).body.id).toBe(
      record.reportId,
    );
    await request(h.app).get(`/api/shared/${link.token}/photos/${secondPhoto.id}`).expect(404);
    await h.api('get', `/api/reports/${record.reportId}`, h.otherToken).expect(404);
    await h
      .api('post', `/api/reports/${record.reportId}/share-links`, h.otherToken)
      .send({ expiresInDays: 7 })
      .expect(404);
  });

  it('rovokes an older link when a new one is created and blocks new image requests on revocation', async () => {
    const record = await readyReport();
    const first = await share(record.reportId);
    const second = await share(record.reportId);
    await request(h.app).get(`/api/shared/${first.token}`).expect(404);
    await request(h.app).get(`/api/shared/${first.token}/photos/${record.photo.id}`).expect(404);
    await request(h.app).get(`/api/shared/${second.token}`).expect(200);
    await h.api('delete', `/api/share-links/${second.shareLink.id}`).expect(204);
    await request(h.app).get(`/api/shared/${second.token}`).expect(404);
    await request(h.app).get(`/api/shared/${second.token}/photos/${record.photo.id}`).expect(404);
  });

  it('applies expiry to both the report and photos', async () => {
    const record = await readyReport();
    const link = await share(record.reportId);
    await h.db.query(
      "UPDATE app.share_links SET created_at = now() - interval '8 days', expires_at = now() - interval '1 minute' WHERE id = $1",
      [link.shareLink.id],
    );
    await request(h.app).get(`/api/shared/${link.token}`).expect(404);
    await request(h.app).get(`/api/shared/${link.token}/photos/${record.photo.id}`).expect(404);
  });

  it('allows sharing to stop while the stay is archived', async () => {
    const record = await readyReport();
    const out = await h
      .api('post', `/api/stays/${record.stay.id}/move-out`)
      .send({ baselineReportId: record.reportId })
      .expect(201);
    await h.fillInspection({ stay: record.stay, inspectionId: out.body.inspection.id });
    const completed = await h.complete(out.body.inspection.id);
    const link = await share(completed.reportId);
    await h.api('post', `/api/stays/${record.stay.id}/archive`).expect(200);
    await h.api('delete', `/api/share-links/${link.shareLink.id}`).expect(204);
    await request(h.app).get(`/api/shared/${link.token}`).expect(404);
  });
});

describe('deletion and cleanup', () => {
  it.each(['photo', 'stay'] as const)(
    'does not restore a %s removed during an in-flight upload',
    async (removeTarget) => {
      const record = await h.makeRecord();
      const view = await h.getInspection(record.inspectionId);
      let unblock: () => void = () => {};
      let announce: () => void = () => {};
      const release = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        announce = resolve;
      });
      let paused = false;
      const delayedApp = createApp({
        db: h.db,
        config: h.config,
        storage: {
          ...h.storage,
          put: async (key, bytes) => {
            if (!paused) {
              paused = true;
              announce();
              await release;
            }
            await h.storage.put(key, bytes);
          },
        },
      });
      const uploading = request(delayedApp)
        .post(`/api/observations/${view.rooms[0]!.items[0]!.observation.id}/photos`)
        .set('Authorization', `Bearer ${h.token}`)
        .field('clientUploadId', randomUUID())
        .field('expectedEditVersion', String(view.inspection.editVersion))
        .attach('file', jpeg, { filename: 'wall.jpg', contentType: 'image/jpeg' })
        .then((response) => response);
      await Promise.race([
        entered,
        uploading.then((response) => {
          throw new Error(
            `Upload ended before storage was reached: ${response.status} ${JSON.stringify(response.body)}`,
          );
        }),
      ]);
      let photoId = '';
      try {
        const pending = await h.getInspection(record.inspectionId);
        const photo = pending.rooms[0]!.items[0]!.observation.photos[0]!;
        photoId = photo.id;
        expect(photo.status).toBe('pending');
        if (removeTarget === 'photo') {
          await h
            .api('delete', `/api/photos/${photoId}`)
            .send({ expectedEditVersion: pending.inspection.editVersion })
            .expect(200);
        } else {
          await h
            .api('delete', `/api/stays/${record.stay.id}`)
            .send({ confirmationTitle: record.stay.title })
            .expect(202);
        }
      } finally {
        unblock();
      }
      expect((await uploading).status).toBe(409);
      expect((await h.storage.list()).some((file) => file.key.includes(photoId))).toBe(false);
      if (removeTarget === 'photo') {
        expect(
          (await h.getInspection(record.inspectionId)).rooms[0]!.items[0]!.observation.photos,
        ).toHaveLength(0);
      } else {
        await h.api('get', `/api/stays/${record.stay.id}`).expect(404);
      }
    },
  );

  it('requires the record title before deleting content', async () => {
    const record = await h.makeRecord();
    const response = await h
      .api('delete', `/api/stays/${record.stay.id}`)
      .send({ confirmationTitle: 'wrong title' });
    expect([400, 422]).toContain(response.status);
    await h.api('get', `/api/stays/${record.stay.id}`).expect(200);
  });

  it('denies reads immediately, preserves a retry entry after storage failure, then finishes deletion', async () => {
    const record = await readyReport();
    const link = await share(record.reportId);
    h.faults.remove = true;
    await h
      .api('delete', `/api/stays/${record.stay.id}`)
      .send({ confirmationTitle: record.stay.title })
      .expect(202);
    await h.api('get', `/api/stays/${record.stay.id}`).expect(404);
    await h.api('get', `/api/reports/${record.reportId}`).expect(404);
    await h.api('get', `/api/photos/${record.photo.id}/content`).expect(404);
    await request(h.app).get(`/api/shared/${link.token}`).expect(404);
    const list = await h.api('get', '/api/stays').query({ q: record.stay.title }).expect(200);
    const pending = list.body.stays.find((stay: { id: string }) => stay.id === record.stay.id);
    expect(pending.deletedAt).toBeTruthy();
    expect(pending.city ?? '').toBe('');
    h.faults.remove = false;
    await h
      .api('delete', `/api/stays/${record.stay.id}`)
      .send({ confirmationTitle: record.stay.title })
      .expect(202);
    await cleanupResources({ db: h.db, storage: h.storage });
    const remaining = await h.db.query('SELECT id FROM app.stays WHERE id = $1', [record.stay.id]);
    expect(remaining.rows).toHaveLength(0);
    const photos = await h.storage.list();
    expect(photos.some((photo) => photo.key.includes(record.photo.id))).toBe(false);
  });

  it('deletes a stay with both inspection reports without violating baseline references', async () => {
    const record = await readyReport();
    const out = await h
      .api('post', `/api/stays/${record.stay.id}/move-out`)
      .send({ baselineReportId: record.reportId })
      .expect(201);
    await h.fillInspection({ stay: record.stay, inspectionId: out.body.inspection.id });
    await h.complete(out.body.inspection.id);
    await h
      .api('delete', `/api/stays/${record.stay.id}`)
      .send({ confirmationTitle: record.stay.title })
      .expect(202);
    await cleanupResources({ db: h.db, storage: h.storage });
    for (const table of [
      'stays',
      'inspections',
      'reports',
      'observations',
      'photos',
      'report_photos',
      'share_links',
      'rooms',
      'check_items',
    ]) {
      const column = table === 'stays' ? 'id' : 'stay_id';
      const result = await h.db.query(
        `SELECT count(*)::int AS count FROM app.${table} WHERE ${column} = $1`,
        [record.stay.id],
      );
      expect(result.rows[0]!.count).toBe(0);
    }
  });
});
