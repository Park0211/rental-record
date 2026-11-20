import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { todayInZone, type Condition, type InspectionView } from '@rental-record/contracts';
import { DEMO_USERS } from './auth';
import type { Database } from './db.js';
import type { PhotoStorage } from './storage';
import { createStay } from './services/stays.js';
import {
  completeInspection,
  getInspection,
  startMoveOut,
  updateInspection,
  updateObservation,
} from './services/inspections.js';
import { uploadPhoto } from './services/photos.js';

const ownerId = DEMO_USERS[0].id;
const zone = 'America/New_York';

function daysAgo(days: number): string {
  return todayInZone(zone, new Date(Date.now() - days * 86400000));
}

async function samplePhoto(scratch: boolean): Promise<Buffer> {
  const drawing = `<svg xmlns ="http://www.w3.org/2000/svg" width="1000" height="700" viewBox="0 0 1000 700">
        <rect width="1000" height="700" fill="#e8e1d4"/>
        <rect y="550" width="1000" height="150" fill="#bf9f7a"/>
        <path d="M0 550H1000" stroke="#f8f5ed" stroke-width="20"/>
        <rect x="100" y="100" width="270" height="320" fill="#fdfbf5"/>
        <rect x="115" y="115" width="240" height="290" fill="#c7dbdd"/>
        <path d="M235 115V405M115 260H355" stroke="#fdfbf5" stroke-width="12"/>
        <path d="M445 325l48 14m-31-3l35 15" fill="none" stroke="#8e8578" stroke-width="4" stroke-linecap="round"/>
        ${scratch ? '<path d="M555 597l77 18m-68-8l73 19" stroke="#765640" stroke-width="5" stroke-linecap="round"/>' : ''}
        <rect x="640" y="35" width="325" height="44" rx="4" fill="#ffffff"/>
        <text x="802" y="64" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#374151">Sample illustration</text>
    </svg>`;
  return sharp(Buffer.from(drawing)).jpeg({ quality: 88 }).toBuffer();
}

async function fill(db: Database, inspectionId: string, date: string, moveOut: boolean) {
  let view = await getInspection(db, ownerId, inspectionId);
  let { editVersion } = await updateInspection(db, ownerId, inspectionId, {
    inspectionDate: date,
    expectedEditVersion: view.inspection.editVersion,
  });
  for (const room of view.rooms) {
    for (const item of room.items) {
      let condition: Condition = 'no_issue';
      let notes = '';
      if (room.roomType === 'living_room' && item.name === 'Walls') {
        condition = 'issue';
        notes = moveOut
          ? 'A small scuff is visible to the right of the window. See the attached sample illustration.'
          : 'Small scuff to the right of the window, about 2 inches long. Sample record.';
      } else if (room.roomType === 'bedroom' && item.name === 'Floor' && moveOut) {
        condition = 'issue';
        notes = 'A scratch is visible near the doorway. Sample record.';
      } else if (room.roomType === 'bedroom' && item.name === 'Closet' && !moveOut) {
        condition = 'not_checked';
        notes = 'The closet was locked at the time of this inspection.';
      } else if (room.roomType === 'kitchen' && item.name === 'Refrigerator') {
        condition = 'not_applicable';
        notes = 'No refrigerator was installed during this stay.';
      }
      ({ editVersion } = await updateObservation(db, ownerId, item.observation.id, {
        condition,
        notes,
        expectedEditVersion: editVersion,
      }));
    }
  }
  view = await getInspection(db, ownerId, inspectionId);
  return view;
}

async function attachSample(
  db: Database,
  storage: PhotoStorage,
  view: InspectionView,
  moveOut: boolean,
) {
  const room = view.rooms.find((entry) => entry.roomType === 'living_room')!;
  const item = room.items.find((entry) => entry.name === 'Walls')!;
  const buffer = await samplePhoto(moveOut);
  return uploadPhoto(
    { db, storage },
    ownerId,
    item.observation.id,
    {
      clientUploadId: randomUUID(),
      expectedEditVersion: view.inspection.editVersion,
    },
    { buffer, size: buffer.length, originalname: 'sample-room.jpg', mimetype: 'image/jpeg' },
  );
}

export async function seedDemo(db: Database, storage: PhotoStorage): Promise<boolean> {
  const count = await db.query<{ count: string }>('SELECT count(*) AS count From app.stays');
  if (Number(count.rows[0].count) > 0) return false;
  const { stay, inspection } = await createStay(db, ownerId, {
    title: 'Demo Apartment',
    city: 'Boston',
    state: 'MA',
    timeZone: zone,
    roomTypes: ['living_room', 'bedroom', 'kitchen', 'bathroom'],
  });
  const moveIn = await fill(db, inspection.id, daysAgo(90), false);
  const photo = await attachSample(db, storage, moveIn, false);
  const baseline = await completeInspection(db, ownerId, inspection.id, {
    requestId: randomUUID(),
    expectedEditVersion: photo.editVersion,
  });
  const moveOut = await startMoveOut(db, ownerId, stay.id, {
    baselineReportId: baseline.reportId,
    inspectionDate: daysAgo(1),
  });
  const outView = await fill(db, moveOut.inspection.id, daysAgo(1), true);
  const outPhoto = await attachSample(db, storage, outView, true);
  await completeInspection(db, ownerId, moveOut.inspection.id, {
    requestId: randomUUID(),
    expectedEditVersion: outPhoto.editVersion,
  });

  const draft = await createStay(db, ownerId, {
    title: 'New place checklist',
    city: 'Chicago',
    state: 'IL',
    timeZone: 'America/Chicago',
    roomTypes: ['living_room', 'bedroom'],
  });
  const draftView = await getInspection(db, ownerId, draft.inspection.id);
  await updateObservation(db, ownerId, draftView.rooms[0].items[0].observation.id, {
    condition: 'issue',
    notes: 'Small mark beside the light switch. Add a photo before completing the record.',
    expectedEditVersion: draftView.inspection.editVersion,
  });
  return true;
}
