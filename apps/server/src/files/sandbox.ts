import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../utils/errors.js';
import { createExclusionMatcher, type ExclusionMatcher, sanitizePatterns } from './exclusions.js';
import { isInside, normalizeRelativePath } from './paths.js';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'blocked';
  size?: number;
  blocked?: boolean;
  reason?: string;
}

export interface DirectoryListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface TextFile {
  path: string;
  content: string;
  bytes: number;
  lines: number;
  sha256: string;
  mode: number;
  modifiedAt: number;
}

export interface FileLimits {
  maxFileBytes: number;
  maxContextBytes: number;
  maxContextFiles: number;
  excludePatterns: string[];
}

const MAX_ENTRIES = 500;
const TEMP_PREFIX = '.forge-tmp-';

export class FileSandbox {
  readonly projectsRoot: string;
  #rootRealPromise: Promise<string> | null = null;

  constructor(projectsRoot: string) {
    this.projectsRoot = path.resolve(projectsRoot);
  }

  async ensureRoot(): Promise<string> {
    if (!this.#rootRealPromise) {
      this.#rootRealPromise = (async () => {
        await fs.mkdir(this.projectsRoot, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(this.projectsRoot);
        if (!stat.isDirectory()) {
          throw new AppError(
            500,
            'PROJECTS_ROOT_INVALID',
            'La raíz de proyectos no es un directorio.',
          );
        }
        return fs.realpath(this.projectsRoot);
      })();
    }
    return this.#rootRealPromise;
  }

  async resolveProjectBase(projectRoot: string): Promise<string> {
    const rootReal = await this.ensureRoot();
    const relative = normalizeRelativePath(projectRoot, false);
    const candidate = path.resolve(rootReal, relative);
    if (!isInside(rootReal, candidate)) {
      throw new AppError(400, 'PATH_TRAVERSAL', 'El proyecto está fuera de la raíz permitida.');
    }
    await this.#assertNoSymlinks(rootReal, candidate, false);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw new AppError(
        409,
        'PROJECT_UNAVAILABLE',
        'La carpeta del proyecto ya no está disponible en el servidor.',
      );
    }
    if (!isInside(rootReal, real)) {
      throw new AppError(
        403,
        'PATH_OUTSIDE_ROOT',
        'El proyecto apunta fuera de la raíz permitida.',
      );
    }
    const stat = await fs.lstat(real);
    if (!stat.isDirectory()) {
      throw new AppError(400, 'NOT_A_DIRECTORY', 'La ruta del proyecto no es un directorio.');
    }
    return real;
  }

  async assertProjectDirectory(
    relativePath: string,
  ): Promise<{ relativePath: string; name: string }> {
    const relative = normalizeRelativePath(relativePath, false);
    const rootReal = await this.ensureRoot();
    const candidate = path.resolve(rootReal, relative);
    if (!isInside(rootReal, candidate)) {
      throw new AppError(400, 'PATH_TRAVERSAL', 'La carpeta está fuera de la raíz permitida.');
    }
    await this.#assertNoSymlinks(rootReal, candidate, false);
    const stat = await fs.lstat(candidate);
    if (!stat.isDirectory()) {
      throw new AppError(400, 'NOT_A_DIRECTORY', 'Debes seleccionar una carpeta, no un archivo.');
    }
    return { relativePath: relative, name: path.basename(relative) || relative };
  }

  async listWorkspace(relativePath = ''): Promise<DirectoryListing> {
    const rootReal = await this.ensureRoot();
    const relative = normalizeRelativePath(relativePath);
    const target = path.resolve(rootReal, relative);
    if (!isInside(rootReal, target)) {
      throw new AppError(400, 'PATH_TRAVERSAL', 'La ruta sale de la raíz permitida.');
    }
    await this.#assertNoSymlinks(rootReal, target, false);
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) {
      throw new AppError(400, 'NOT_A_DIRECTORY', 'La ruta no es un directorio.');
    }
    const matcher = createExclusionMatcher();
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const entries: FileEntry[] = [];
    let truncated = false;
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const childRelative = path.posix.join(relative, dirent.name);
      if (matcher.isExcluded(childRelative) || dirent.name.startsWith('.')) continue;
      if (dirent.isSymbolicLink()) {
        entries.push({
          name: dirent.name,
          path: childRelative,
          type: 'blocked',
          blocked: true,
          reason: 'Los enlaces simbólicos no se permiten.',
        });
        continue;
      }
      if (dirent.isDirectory()) {
        entries.push({ name: dirent.name, path: childRelative, type: 'directory' });
      }
    }
    return {
      path: relative,
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
      truncated,
    };
  }

  async listProject(projectRoot: string, relativePath = ''): Promise<DirectoryListing> {
    const base = await this.resolveProjectBase(projectRoot);
    return this.listDirectory(base, relativePath, createExclusionMatcher());
  }

  async listProjectWithLimits(
    projectRoot: string,
    relativePath: string,
    limits: FileLimits,
  ): Promise<DirectoryListing> {
    const base = await this.resolveProjectBase(projectRoot);
    return this.listDirectory(base, relativePath, createExclusionMatcher(limits.excludePatterns));
  }

  async listDirectory(
    base: string,
    relativePath: string,
    matcher: ExclusionMatcher,
  ): Promise<DirectoryListing> {
    const relative = normalizeRelativePath(relativePath);
    const target = path.resolve(base, relative);
    if (!isInside(base, target)) {
      throw new AppError(400, 'PATH_TRAVERSAL', 'La ruta sale del proyecto.');
    }
    await this.#assertNoSymlinks(base, target, false);
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) {
      throw new AppError(400, 'NOT_A_DIRECTORY', 'La ruta no es un directorio.');
    }
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const entries: FileEntry[] = [];
    let truncated = false;
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const childRelative = path.posix.join(relative, dirent.name);
      if (matcher.isExcluded(childRelative) || dirent.name.startsWith(TEMP_PREFIX)) continue;
      if (dirent.isSymbolicLink()) {
        entries.push({
          name: dirent.name,
          path: childRelative,
          type: 'blocked',
          blocked: true,
          reason: 'Enlace simbólico bloqueado.',
        });
        continue;
      }
      if (dirent.isDirectory()) {
        entries.push({ name: dirent.name, path: childRelative, type: 'directory' });
        continue;
      }
      if (dirent.isFile()) {
        let size: number | undefined;
        try {
          size = (await fs.lstat(path.join(target, dirent.name))).size;
        } catch {
          size = undefined;
        }
        entries.push({ name: dirent.name, path: childRelative, type: 'file', size });
      }
    }
    return {
      path: relative,
      entries: entries.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      }),
      truncated,
    };
  }

  async readTextFile(
    projectRoot: string,
    relativePath: string,
    limits: FileLimits,
  ): Promise<TextFile> {
    const normalized = normalizeRelativePath(relativePath, false);
    const base = await this.resolveProjectBase(projectRoot);
    const matcher = createExclusionMatcher(limits.excludePatterns);
    if (matcher.isExcluded(normalized)) {
      throw new AppError(
        403,
        'FILE_EXCLUDED',
        `El archivo "${normalized}" está excluido por seguridad o por tu configuración.`,
      );
    }
    const target = path.resolve(base, normalized);
    if (!isInside(base, target)) {
      throw new AppError(400, 'PATH_TRAVERSAL', 'La ruta sale del proyecto.');
    }
    try {
      await this.#assertNoSymlinks(base, target, true);
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') {
        throw new AppError(404, 'FILE_NOT_FOUND', `El archivo "${normalized}" no existe.`);
      }
      throw error;
    }

    let handle: FileHandle;
    try {
      handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw this.#mapOpenError(error, normalized);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new AppError(400, 'NOT_A_FILE', 'La ruta no es un archivo regular.');
      }
      if (stat.size > limits.maxFileBytes) {
        throw new AppError(
          413,
          'FILE_TOO_LARGE',
          `El archivo "${normalized}" supera el límite de ${limits.maxFileBytes} bytes.`,
          { details: { path: normalized, size: stat.size, limit: limits.maxFileBytes } },
        );
      }
      // Lectura por fragmentos: evita reservar stat.size de golpe y aborta en
      // cuanto el archivo supera el límite (aunque haya crecido tras el stat).
      const chunkSize = 64 * 1024;
      const chunks: Buffer[] = [];
      let total = 0;
      let position = 0;
      while (total <= limits.maxFileBytes) {
        const chunk = Buffer.allocUnsafe(Math.min(chunkSize, limits.maxFileBytes + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        total += bytesRead;
        position += bytesRead;
        if (total > limits.maxFileBytes) {
          throw new AppError(413, 'FILE_TOO_LARGE', 'El archivo creció y supera el límite.');
        }
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const content = Buffer.concat(chunks, total);
      if (content.includes(0)) {
        throw new AppError(
          415,
          'BINARY_FILE',
          `El archivo "${normalized}" parece binario y no se enviará.`,
        );
      }
      if (!isUtf8(content)) {
        throw new AppError(
          415,
          'INVALID_ENCODING',
          `El archivo "${normalized}" no está en UTF-8 válido.`,
        );
      }
      const text = content.toString('utf8');
      return {
        path: normalized,
        content: text,
        bytes: content.length,
        lines: text ? text.split('\n').length : 0,
        sha256: createHash('sha256').update(content).digest('hex'),
        mode: stat.mode & 0o777,
        modifiedAt: Math.floor(stat.mtimeMs),
      };
    } finally {
      await handle.close();
    }
  }

  async hashFile(projectRoot: string, relativePath: string): Promise<string | null> {
    const normalized = normalizeRelativePath(relativePath, false);
    const base = await this.resolveProjectBase(projectRoot);
    const target = path.resolve(base, normalized);
    if (!isInside(base, target)) {
      throw new AppError(400, 'PATH_TRAVERSAL', 'La ruta sale del proyecto.');
    }
    try {
      await this.#assertNoSymlinks(base, target, true);
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return null;
      throw error;
    }
    let handle: FileHandle;
    try {
      handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw this.#mapOpenError(error, normalized);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return hash.digest('hex');
    } finally {
      await handle.close();
    }
  }

  async readFileBuffer(
    projectRoot: string,
    relativePath: string,
    maxBytes: number,
  ): Promise<{ content: Buffer; mode: number }> {
    const normalized = normalizeRelativePath(relativePath, false);
    const base = await this.resolveProjectBase(projectRoot);
    const target = path.resolve(base, normalized);
    if (!isInside(base, target)) {
      throw new AppError(400, 'PATH_TRAVERSAL', 'La ruta sale del proyecto.');
    }
    await this.#assertNoSymlinks(base, target, false);
    let handle: FileHandle;
    try {
      handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw this.#mapOpenError(error, normalized);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new AppError(400, 'NOT_A_FILE', 'La ruta no es un archivo regular.');
      }
      if (stat.size > maxBytes) {
        throw new AppError(413, 'FILE_TOO_LARGE', 'El archivo supera el límite permitido.');
      }
      const content = await handle.readFile();
      if (content.length > maxBytes) {
        throw new AppError(413, 'FILE_TOO_LARGE', 'El archivo supera el límite permitido.');
      }
      return { content, mode: stat.mode & 0o777 };
    } finally {
      await handle.close();
    }
  }

  async writeFileAtomic(input: {
    projectRoot: string;
    path: string;
    content: string;
    expectedHash: string | null;
    maxBytes: number;
  }): Promise<{ sha256: string; bytes: number; mode: number }> {
    const normalized = normalizeRelativePath(input.path, false);
    const base = await this.resolveProjectBase(input.projectRoot);
    const target = path.resolve(base, normalized);
    if (!isInside(base, target)) {
      throw new AppError(400, 'PATH_TRAVERSAL', 'La ruta sale del proyecto.');
    }
    if (normalized.split('/').some((segment) => segment.startsWith(TEMP_PREFIX))) {
      throw new AppError(400, 'INVALID_PATH', 'Nombre de archivo reservado.');
    }
    const matcher = createExclusionMatcher();
    if (matcher.isExcluded(normalized)) {
      throw new AppError(
        403,
        'FILE_EXCLUDED',
        'No se puede escribir en un archivo excluido por seguridad.',
      );
    }
    const content = Buffer.from(input.content, 'utf8');
    if (content.length > input.maxBytes) {
      throw new AppError(413, 'FILE_TOO_LARGE', 'El contenido propuesto supera el límite.');
    }

    const parent = path.dirname(target);
    await this.#assertNoSymlinks(base, parent, false);
    const parentStat = await fs.lstat(parent);
    if (!parentStat.isDirectory()) {
      throw new AppError(400, 'NOT_A_DIRECTORY', 'La carpeta destino no existe.');
    }

    let existingMode = 0o644;
    let existing: Stats | null = null;
    try {
      existing = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing) {
      if (existing.isSymbolicLink()) {
        throw new AppError(
          403,
          'SYMLINK_BLOCKED',
          'No se permite escribir a través de un symlink.',
        );
      }
      if (!existing.isFile()) {
        throw new AppError(400, 'NOT_A_FILE', 'El destino no es un archivo regular.');
      }
      existingMode = existing.mode & 0o777;
    }

    if (input.expectedHash !== null) {
      if (!existing) {
        throw new AppError(
          409,
          'FILE_CHANGED',
          'El archivo ya no existe. Vuelve a generar la propuesta.',
        );
      }
      const currentHash = await this.hashFile(input.projectRoot, normalized);
      if (currentHash !== input.expectedHash) {
        throw new AppError(
          409,
          'FILE_CHANGED',
          'El archivo cambió desde que se generó la propuesta. Revísala de nuevo.',
        );
      }
    } else if (existing) {
      throw new AppError(409, 'FILE_EXISTS', 'El archivo ya existe. Recarga y vuelve a proponer.');
    }

    const tempPath = path.join(
      parent,
      `${TEMP_PREFIX}${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    );
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.chmod(tempPath, existingMode);
      await fs.rename(tempPath, target);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
    return {
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.length,
      mode: existingMode,
    };
  }

  async deleteFile(input: {
    projectRoot: string;
    path: string;
    expectedHash: string;
  }): Promise<void> {
    const normalized = normalizeRelativePath(input.path, false);
    const base = await this.resolveProjectBase(input.projectRoot);
    const target = path.resolve(base, normalized);
    if (!isInside(base, target)) {
      throw new AppError(400, 'PATH_TRAVERSAL', 'La ruta sale del proyecto.');
    }
    const matcher = createExclusionMatcher();
    if (matcher.isExcluded(normalized)) {
      throw new AppError(403, 'FILE_EXCLUDED', 'No se puede borrar un archivo excluido.');
    }
    await this.#assertNoSymlinks(base, target, false);
    const stat = await fs.lstat(target);
    if (!stat.isFile()) {
      throw new AppError(400, 'NOT_A_FILE', 'Solo se pueden borrar archivos regulares.');
    }
    const currentHash = await this.hashFile(input.projectRoot, normalized);
    if (currentHash !== input.expectedHash) {
      throw new AppError(
        409,
        'FILE_CHANGED',
        'El archivo cambió desde que se generó la propuesta.',
      );
    }
    await fs.unlink(target);
  }

  async #assertNoSymlinks(base: string, target: string, allowMissingLeaf: boolean): Promise<void> {
    if (!isInside(base, target)) {
      throw new AppError(400, 'PATH_TRAVERSAL', 'La ruta sale del proyecto.');
    }
    const relative = path.relative(base, target);
    if (!relative) return;
    const segments = relative.split(path.sep);
    let current = base;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]!);
      let stat: Stats;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if (
          allowMissingLeaf &&
          index === segments.length - 1 &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          throw new AppError(404, 'PATH_NOT_FOUND', 'La ruta no existe.');
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new AppError(404, 'PATH_NOT_FOUND', 'La ruta no existe.');
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new AppError(
          403,
          'SYMLINK_BLOCKED',
          'La ruta contiene un enlace simbólico y ha sido bloqueada.',
        );
      }
    }
  }

  #mapOpenError(error: unknown, relativePath: string): AppError {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return new AppError(404, 'FILE_NOT_FOUND', `El archivo "${relativePath}" no existe.`);
    }
    if (code === 'ELOOP') {
      return new AppError(
        403,
        'SYMLINK_BLOCKED',
        'No se permite leer a través de enlaces simbólicos.',
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return new AppError(403, 'FILE_ACCESS_DENIED', 'No hay permisos para leer ese archivo.');
    }
    return new AppError(500, 'FILE_READ_ERROR', 'No se pudo leer el archivo.');
  }
}

export function makeLimits(input: {
  maxFileBytes: number;
  maxContextBytes: number;
  maxContextFiles: number;
  excludePatterns?: readonly string[];
}): FileLimits {
  return {
    maxFileBytes: input.maxFileBytes,
    maxContextBytes: input.maxContextBytes,
    maxContextFiles: input.maxContextFiles,
    excludePatterns: sanitizePatterns(input.excludePatterns ?? []),
  };
}
