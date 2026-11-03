import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { details?: Record<string, unknown>; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.expose = options.expose ?? statusCode < 500;
  }
}

export function badRequest(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(400, 'INVALID_INPUT', message, { details });
}

export function unauthorized(message = 'No autenticado.'): AppError {
  return new AppError(401, 'UNAUTHENTICATED', message);
}

export function forbidden(message = 'No tienes permiso para esta operación.'): AppError {
  return new AppError(403, 'FORBIDDEN', message);
}

export function notFound(message = 'Recurso no encontrado.'): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function conflict(message: string, code = 'CONFLICT'): AppError {
  return new AppError(409, code, message);
}

export function tooManyRequests(message: string, retryAfterSeconds: number): AppError {
  return new AppError(429, 'RATE_LIMITED', message, {
    details: { retryAfterSeconds },
  });
}

export interface PublicErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

export function toPublicError(error: unknown, requestId?: string): PublicErrorBody {
  if (error instanceof AppError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  if (error instanceof ZodError) {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Los datos enviados no son válidos.',
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Ocurrió un error interno. Inténtalo de nuevo.',
      ...(requestId ? { requestId } : {}),
    },
  };
}

export async function errorHandler(
  error: Error & { statusCode?: number; code?: string; validation?: unknown },
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (reply.sent) return;

  if (error.statusCode === 429) {
    reply
      .code(429)
      .type('application/json')
      .send(
        toPublicError(
          tooManyRequests('Demasiadas solicitudes. Espera un momento.', 60),
          request.id,
        ),
      );
    return;
  }
  if (error.statusCode === 413) {
    reply.code(413).send({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'La solicitud es demasiado grande.',
        requestId: request.id,
      },
    });
    return;
  }
  if (error.validation) {
    reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'La solicitud no es válida.',
        requestId: request.id,
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    reply.code(400).send(toPublicError(error, request.id));
    return;
  }

  if (!(error instanceof AppError) && (error.statusCode ?? 500) >= 500) {
    request.log.error(
      { err: error, requestId: request.id, code: error.code },
      'Error no controlado',
    );
  }

  const status = error instanceof AppError ? error.statusCode : (error.statusCode ?? 500);
  reply.code(status >= 400 && status < 600 ? status : 500).send(toPublicError(error, request.id));
}
