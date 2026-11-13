import { z } from 'zod';

export const ROOM_TYPES = [
  'living_room',
  'bedroom',
  'kitchen',
  'bathroom',
  'hallway',
  'laundry',
  'other',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];
export const ROOM_LABELS: Record<RoomType, string> = {
  living_room: 'Living room',
  bedroom: 'Bedroom',
  kitchen: 'Kitchen',
  bathroom: 'Bathroom',
  hallway: 'Hallway',
  laundry: 'Laundry area',
  other: 'Other',
};
export const DEFAULT_ITEMS: Record<RoomType, string[]> = {
  living_room: ['Walls', 'Ceiling', 'Floor', 'Windows', 'Door', 'Lights'],
  bedroom: ['Walls', 'Ceiling', 'Floor', 'Windows', 'Door', 'Closet'],
  kitchen: ['Walls', 'Floor', 'Sink', 'Faucet', 'Cabinets', 'Countertop', 'Refrigerator', 'Stove'],
  bathroom: ['Walls', 'Floor', 'Sink', 'Faucet', 'Toilet', 'Shower or tub', 'Ventilation'],
  hallway: ['Walls', 'Floor', 'Doors', 'Lights'],
  laundry: ['Floor', 'Washer', 'Dryer', 'Visible connections'],
  other: ['General condition'],
};
export const CONDITIONS = ['no_issue', 'issue', 'not_applicable', 'not_checked'] as const;
export type Condition = (typeof CONDITIONS)[number] | null;
export const CONDITION_LABELS: Record<NonNullable<Condition>, string> = {
  no_issue: 'No issue observed',
  issue: 'Issue noted',
  not_applicable: 'Not applicable',
  not_checked: 'Unable to inspect',
};
export const STATE_CODES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;
export const TIME_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Adak',
  'Pacific/Honolulu',
  'America/indiana/Indianapolis',
  'America/Detroit',
  'America/Boise',
] as const;
export const LIMITS = {
  rooms: 10,
  items: 60,
  photosPerItem: 5,
  photosPerInspection: 40,
  photoBytes: 10 * 1024 * 1024,
  imagePixels: 50_000_000,
  notes: 2000,
} as const;

export type InspectionKind = 'move_in' | 'move_out';
export type InspectionStatus = 'draft' | 'completed';
export interface User {
  id: string;
  email: string;
}
export interface PublicConfig {
  authMode: 'demo' | 'supabase';
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export interface Stay {
  id: string;
  title: string;
  city: string;
  state: string;
  street: string;
  unit: string;
  zipCode: string;
  timezone: string;
  archivedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CheckItem {
  id: string;
  stayId: string;
  roomId: string;
  name: string;
  sortOrder: number;
}
export interface Room {
  id: string;
  stayId: string;
  name: string;
  roomType: RoomType;
  sortOrder: number;
  items: CheckItem[];
}
export interface InspectionSummary {
  id: string;
  stayId: string;
  kind: InspectionKind;
  status: InspectionStatus;
  inspectionDate: string | null;
  editVersion: number;
  baselineReportId: string | null;
  reportCount: number;
  latestReportId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Photo {
  id: string;
  clientUploadId: string;
  status: 'pending' | 'ready' | 'failed';
  storedMime: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  uploadedAt: string;
  lastError: string | null;
}
export interface Observation {
  id: string;
  itemId: string;
  condition: Condition;
  notes: string;
  photos: Photo[];
}
export interface InspectionItem extends CheckItem {
  observation: Observation;
}
export interface InspectionRoom extends Omit<Room, 'items'> {
  items: InspectionItem[];
}
export interface CompletionIssue {
  code: string;
  message: string;
  observationId?: string;
  itemId?: string;
  roomId?: string;
}
export interface InspectionView {
  stay: Stay;
  inspection: InspectionSummary;
  rooms: InspectionRoom[];
  editable: boolean;
  completionIssues: CompletionIssue[];
}
export interface SnapshotItem {
  id: string;
  name: string;
  condition: Condition;
  notes: string;
  photos: Photo[];
}
export interface SnapshotRoom {
  id: string;
  name: string;
  roomType: RoomType;
  items: SnapshotItem[];
}
export interface InspectionSnapshot {
  inspectionId: string;
  kind: InspectionKind;
  inspectionDate: string | null;
  rooms: SnapshotRoom[];
}
export interface Baseline {
  reportId: string;
  reportVersion: number;
  inspection: InspectionSnapshot;
}
export interface ReportSnapshot {
  schemaVersion: 1;
  stay: Stay;
  capturedAt: string;
  current: InspectionSnapshot;
  baseline?: Baseline;
}
export interface ReportSummary {
  id: string;
  stayId: string;
  inspectionId: string;
  kind: InspectionKind;
  reportVersion: number;
  createdAt: string;
}
export interface Report extends ReportSummary {
  snapshot: ReportSnapshot;
}
export interface ShareLink {
  id: string;
  reportId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
export interface StayDetail {
  stay: Stay;
  inspections: InspectionSummary[];
  reports: ReportSummary[];
}
export interface StaySetup {
  stay: Stay;
  rooms: Room[];
  inspection: InspectionSummary;
  editable: boolean;
}
export interface comparison {
  stay: Stay;
  baseline: Baseline;
  current: InspectionSnapshot;
}
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

const shortText = (max: number) => z.string().trim().min(1, 'This field is required.').max(max);
export const stayFields = {
  title: shortText(80),
  city: shortText(80),
  state: z.enum(STATE_CODES),
  street: z.string().trim().max(160).default(''),
  unit: z.string().trim().max(30).default(''),
  zipCode: z
    .string()
    .trim()
    .regex(/^$|^\d{5}(-\d{4})?$/, 'Use a 5-digit ZIP code or ZIP+4.')
    .default(''),
  timeZone: z.string().refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Choose a vaild time zone.'),
};
export const createStaySchema = z
  .object({ ...stayFields, roomTypes: z.array(z.enum(ROOM_TYPES)).min(1).max(LIMITS.rooms) })
  .strict();
export const updateStaySchema = z
  .object({
    ...stayFields,
    street: z.string().trim().max(160),
    unit: z.string().trim().max(30),
    zipCode: z
      .string()
      .trim()
      .regex(/^$|^\d{5}(-\d{4})?$/, 'use a 5-digit ZIP code or ZIP+4'),
  })
  .partial()
  .strict();
export type CreateStayInput = z.input<typeof createStaySchema>;
export const observationSchema = z
  .object({
    condition: z.enum(CONDITIONS).nullable(),
    notes: z.string().trim().max(LIMITS.notes),
    expectedEditVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine(({ condition, notes }, ctx) => {
    if (condition !== null && condition !== 'no_issue' && !notes.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['notes'],
        message:
          condition === 'issue'
            ? 'Describe what you observed.'
            : 'Add a reason for this selection.',
      });
    }
  });
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function todayInZone(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function observationProblem(condition: Condition, notes: string): string | null {
  if (condition === null) return 'Choose a condition.';
  if (condition !== 'no_issue' && !notes.trim())
    return condition === 'issue'
      ? 'Describe what you observed.'
      : 'Add a reason for this selection.';
  return null;
}
export function conditionComparison(
  before: Condition,
  after: Condition,
): 'unrecorded' | 'unavailable' | 'changed' | 'review_note' | 'same_selection' {
  if (before === null || after === null) return 'unrecorded';
  if (before === 'not_checked' || after === 'not_checked') return 'unavailable';
  if (before !== after) return 'changed';
  if (before === 'issue') return 'review_note';
  return 'same_selection';
}
