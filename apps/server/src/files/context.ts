import type { ProjectRecord, SettingsData } from '../types.js';
import { AppError } from '../utils/errors.js';
import { normalizeRelativePath } from './paths.js';
import type { FileLimits, FileSandbox, TextFile } from './sandbox.js';

export interface ContextFile {
  path: string;
  content: string;
  bytes: number;
  lines: number;
  sha256: string;
}

export interface BuiltContext {
  files: ContextFile[];
  totalBytes: number;
  totalLines: number;
  estimatedTokens: number;
  formatted: string;
}

export interface ContextPreviewFile extends ContextFile {
  selected: boolean;
}

export interface ContextPreview {
  files: ContextPreviewFile[];
  errors: { path: string; code: string; message: string }[];
  totalBytes: number;
  totalLines: number;
  estimatedTokens: number;
  maxContextBytes: number;
  maxFileBytes: number;
  maxContextFiles: number;
  formatted: string;
  truncated: boolean;
}

export function limitsFromSettings(settings: SettingsData): FileLimits {
  return {
    maxFileBytes: settings.maxFileBytes,
    maxContextBytes: settings.maxContextBytes,
    maxContextFiles: settings.maxContextFiles,
    excludePatterns: settings.excludePatterns,
  };
}

export async function buildContext(input: {
  sandbox: FileSandbox;
  project: ProjectRecord;
  paths: readonly string[];
  limits: FileLimits;
}): Promise<BuiltContext> {
  const unique = [...new Set(input.paths.map((item) => normalizeRelativePath(item, false)))];
  if (unique.length > input.limits.maxContextFiles) {
    throw new AppError(
      400,
      'TOO_MANY_FILES',
      `Puedes adjuntar como máximo ${input.limits.maxContextFiles} archivos por consulta.`,
    );
  }

  const files: ContextFile[] = [];
  let totalBytes = 0;
  for (const relativePath of unique) {
    const file = await input.sandbox.readTextFile(
      input.project.rootPath,
      relativePath,
      input.limits,
    );
    if (totalBytes + file.bytes > input.limits.maxContextBytes) {
      throw new AppError(
        413,
        'CONTEXT_TOO_LARGE',
        `El contexto supera el límite de ${input.limits.maxContextBytes} bytes. Quita archivos o aumenta el límite en Ajustes.`,
        { details: { limit: input.limits.maxContextBytes, used: totalBytes } },
      );
    }
    totalBytes += file.bytes;
    files.push(publicFile(file));
  }

  const formatted = formatContextFiles(files);
  return {
    files,
    totalBytes,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    estimatedTokens: estimateTokens(formatted),
    formatted,
  };
}

export async function previewContext(input: {
  sandbox: FileSandbox;
  project: ProjectRecord;
  paths: readonly string[];
  limits: FileLimits;
}): Promise<ContextPreview> {
  const unique = [...new Set(input.paths.map((item) => normalizeRelativePath(item, false)))];
  const previewFiles: ContextPreviewFile[] = [];
  const errors: ContextPreview['errors'] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const relativePath of unique) {
    if (!relativePath) continue;
    if (previewFiles.length >= input.limits.maxContextFiles) {
      errors.push({
        path: relativePath,
        code: 'TOO_MANY_FILES',
        message: `Máximo ${input.limits.maxContextFiles} archivos por consulta.`,
      });
      truncated = true;
      continue;
    }
    try {
      const file = await input.sandbox.readTextFile(
        input.project.rootPath,
        relativePath,
        input.limits,
      );
      if (totalBytes + file.bytes > input.limits.maxContextBytes) {
        errors.push({
          path: relativePath,
          code: 'CONTEXT_TOO_LARGE',
          message: `Supera el límite total de contexto (${input.limits.maxContextBytes} bytes).`,
        });
        truncated = true;
        continue;
      }
      totalBytes += file.bytes;
      previewFiles.push({ ...publicFile(file), selected: true });
    } catch (error) {
      if (error instanceof AppError) {
        errors.push({ path: relativePath, code: error.code, message: error.message });
      } else {
        errors.push({
          path: relativePath,
          code: 'FILE_READ_ERROR',
          message: 'No se pudo leer el archivo.',
        });
      }
      truncated = true;
    }
  }

  const formatted = formatContextFiles(previewFiles);
  return {
    files: previewFiles,
    errors,
    totalBytes,
    totalLines: previewFiles.reduce((sum, file) => sum + file.lines, 0),
    estimatedTokens: estimateTokens(formatted),
    maxContextBytes: input.limits.maxContextBytes,
    maxFileBytes: input.limits.maxFileBytes,
    maxContextFiles: input.limits.maxContextFiles,
    formatted,
    truncated,
  };
}

export function formatContextFiles(files: readonly ContextFile[]): string {
  if (files.length === 0) return '';
  const boundary = '<<<FORGE_CONTEXT_FILE>>>';
  return files
    .map(
      (file) =>
        `${boundary} path="${file.path}" bytes="${file.bytes}"\n${file.content}\n<<<END_FORGE_CONTEXT_FILE>>>`,
    )
    .join('\n\n');
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function publicFile(file: TextFile): ContextFile {
  return {
    path: file.path,
    content: file.content,
    bytes: file.bytes,
    lines: file.lines,
    sha256: file.sha256,
  };
}
