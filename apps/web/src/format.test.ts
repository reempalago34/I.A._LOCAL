import { describe, expect, it } from 'vitest';
import {
  basename,
  classNames,
  dirname,
  formatBytes,
  formatDate,
  joinPath,
  pluralize,
  relativeTime,
} from './lib/format';

describe('formatBytes', () => {
  it('formatea bytes y unidades de forma legible', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });
});

describe('fechas y rutas', () => {
  it('formatea fechas con locale es/en', () => {
    const timestamp = Date.UTC(2026, 0, 2, 12, 30);
    expect(formatDate(timestamp, 'en')).toMatch(/2026/);
    expect(formatDate(timestamp, 'es')).toMatch(/2026/);
  });

  it('calcula tiempo relativo en inglés', () => {
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);
    expect(relativeTime(now - 5_000, now, 'en')).toBe('5 seconds ago');
    expect(relativeTime(now - 5 * 60_000, now, 'en')).toBe('5 minutes ago');
    expect(relativeTime(now - 3 * 3_600_000, now, 'en')).toBe('3 hours ago');
    expect(relativeTime(now + 2 * 86_400_000, now, 'en')).toBe('in 2 days');
  });

  it('manipula rutas posix', () => {
    expect(basename('src/components/Button.tsx')).toBe('Button.tsx');
    expect(basename('README.md')).toBe('README.md');
    expect(dirname('src/components/Button.tsx')).toBe('src/components');
    expect(dirname('README.md')).toBe('');
    expect(joinPath('', 'file.ts')).toBe('file.ts');
    expect(joinPath('src/', 'file.ts')).toBe('src/file.ts');
    expect(joinPath('src/components', 'file.ts')).toBe('src/components/file.ts');
  });
});

describe('utilidades de texto', () => {
  it('pluraliza y une clases', () => {
    expect(pluralize(1, 'archivo', 'archivos')).toBe('1 archivo');
    expect(pluralize(2, 'archivo', 'archivos')).toBe('2 archivos');
    expect(pluralize(0, 'archivo', 'archivos')).toBe('0 archivos');
    expect(classNames('a', false, null, undefined, 'b')).toBe('a b');
    expect(classNames()).toBe('');
  });
});
