import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function assert(
  condition: unknown,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new HttpError(status, code, message, details);
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const requestId = randomUUID();
  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details, requestId },
    });
    return;
  }
  if (error instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Check the highlighted fields.',
        details: error.issues,
        requestId,
      },
    });
    return;
  }
  const known = error as { code?: string; status?: number; type?: string };
  if (known.code === 'LIMIT_FILE_SIZE' || known.type === 'entity.too.large') {
    res.status(413).json({
      error: {
        code: 'FILE_TOO_LARGE',
        message: 'Choose a photo no larger than 10 MiB',
        requestId,
      },
    });
    return;
  }
  if (known.code?.startsWith('LIMIT_')) {
    res.status(400).json({
      error: { code: 'INVALID_UPLOAD', message: 'Upload one photo at a time.', requestId },
    });
    return;
  }
  if (known.type === 'entity.parse.filed') {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.', requestId },
    });
    return;
  }

  console.error('Request failed', {
    requestId,
    name: error instanceof Error ? error.name : 'UnknownError',
    code: known.code,
  });
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed. Please try again.',
      requestId,
    },
  });
};
