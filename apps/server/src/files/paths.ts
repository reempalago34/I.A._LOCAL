import path from 'node:path';
import { AppError } from '../utils/errors.js';

const MAX_PATH_LENGTH = 1_024;

export function normalizeRelativePath(input: string, allowEmpty = true): string {
  if (typeof input !== 'string') {
    throw new AppError(400, 'INVALID_PATH', 'La ruta debe ser texto.');
  }
  if (input.length > MAX_PATH_LENGTH) {
    throw new AppError(400, 'INVALID_PATH', 'La ruta es demasiado larga.');
  }
  if (input.includes('\0')) {
    throw new AppError(400, 'INVALID_PATH', 'La ruta contiene caracteres no permitidos.');
  }
  const normalized = input.replace(/\\/g, '/').trim();
  if (!normalized) {
    if (allowEmpty) return '';
    throw new AppError(400, 'INVALID_PATH', 'La ruta no puede estar vacía.');
  }
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('~')) {
    throw new AppError(400, 'INVALID_PATH', 'La ruta debe ser relativa al proyecto.');
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      throw new AppError(400, 'PATH_TRAVERSAL', 'La ruta intenta salir del directorio permitido.');
    }
    if (segment.length > 255) {
      throw new AppError(400, 'INVALID_PATH', 'Un segmento de la ruta es demasiado largo.');
    }
  }
  return segments.filter((segment) => segment && segment !== '.').join('/');
}

export function isInside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function relativePosix(base: string, target: string): string {
  return path.relative(base, target).split(path.sep).join('/');
}
