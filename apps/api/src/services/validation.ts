import { z } from 'zod';
import { isValidDate, ROOM_TYPES } from '@rental-record/contracts';
import { HttpError } from '../errors.js';

export function parse<T>(schma: z.ZodType<T>, value: unknown, status = 400): T {
  const result = schma.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      status,
      'VALIDATION_ERROR',
      result.error.issues[0]?.message ?? 'Check the submitted values.',
      {
        fields: result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

export const uuid = z.string().uuid('Use a valid record ID.');
export const editVersion = z.number().int().positive();
export const versionBody = z.object({ expectedEditVersion: editVersion }).strict();
export const dateField = z
  .string()
  .refine(isValidDate, 'Use a valid date in YYYY-MM-DD format.')
  .nullable();
export const inspectionBody = z
  .object({ inspectionDate: dateField, expectedEditVersion: editVersion })
  .strict();
export const completeBody = z
  .object({ requestId: uuid, expectedEditVersion: editVersion })
  .strict();
export const moveOutBody = z
  .object({ baselineReportId: uuid, inspectionDate: dateField.optional() })
  .strict();
export const roomBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    roomType: z.enum(ROOM_TYPES),
    expectedEditVersion: editVersion,
  })
  .strict();
export const roomNameBody = z
  .object({ name: z.string().trim().min(1).max(60), expectedEditVersion: editVersion })
  .strict();
export const itemBody = z
  .object({ name: z.string().trim().min(1).max(80), expectedEditVersion: editVersion })
  .strict();
export const shareBody = z
  .object({ expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7) })
  .strict();
export const deleteStayBody = z.object({ confirmationTitle: z.string() }).strict();
export const photoBody = z
  .object({
    ClientUploadId: uuid,
    expectedEditVersion: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(editVersion),
  })
  .strict();

export function listQuery(query: Record<string, unknown>) {
  const positive = z
    .string()
    .regex(/^[1-9]\d*$/, 'Use a positive page number.')
    .transform(Number);
  return parse(
    z
      .object({
        q: z.string().max(160).default(''),
        archived: z.enum(['true', 'false', 'all']).default('false'),
        page: positive.pipe(z.number().max(100000)).default(1),
        pageSize: positive.pipe(z.number().max(50)).default(20),
      })
      .strict(),
    query,
  );
}
