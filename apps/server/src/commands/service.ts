import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { validateCommandText } from '../chat/parser.js';
import type { AppConfig } from '../config.js';
import type { Store } from '../db.js';
import type { FileSandbox } from '../files/sandbox.js';
import type { ProjectRecord, UserRecord } from '../types.js';
import { AppError } from '../utils/errors.js';

export interface CommandAnalysis {
  command: string;
  allowed: boolean;
  enabled: boolean;
  reason?: string;
  argv?: string[];
  cwd: string;
  effects: string;
}

export class CommandService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly sandbox: FileSandbox,
  ) {}

  async analyze(user: UserRecord, projectId: string, command: string): Promise<CommandAnalysis> {
    const project = this.#project(user, projectId);
    const validation = validateCommandText(command);
    let allowed = validation.ok;
    let reason = validation.reason;
    if (allowed && validation.argv) {
      const binary = validation.argv[0]!;
      if (binary.includes('/') || binary.includes('\\')) {
        allowed = false;
        reason = 'El ejecutable debe ser un nombre simple, no una ruta.';
      } else if (!this.config.commandAllowlist.includes(binary)) {
        allowed = false;
        reason = `El ejecutable "${binary}" no está en la lista permitida.`;
      }
    }
    return {
      command: command.trim(),
      allowed,
      enabled: this.config.enableCommandExecution,
      reason,
      ...(validation.argv && allowed ? { argv: validation.argv } : {}),
      cwd: project.name,
      effects:
        'El comando se ejecutaría dentro de la carpeta del proyecto con un entorno mínimo. Puede modificar archivos, instalar dependencias o consumir recursos. No hay aislamiento de contenedor desde la aplicación.',
    };
  }

  async execute(
    user: UserRecord,
    projectId: string,
    command: string,
  ): Promise<{
    command: string;
    cwd: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    truncated: boolean;
    durationMs: number;
    stdout: string;
    stderr: string;
  }> {
    if (!this.config.enableCommandExecution) {
      throw new AppError(
        403,
        'COMMANDS_DISABLED',
        'La ejecución de comandos está deshabilitada. Un administrador debe habilitarla explícitamente.',
      );
    }
    const project = this.#project(user, projectId);
    const analysis = await this.analyze(user, projectId, command);
    if (!analysis.allowed || !analysis.argv) {
      throw new AppError(
        400,
        'COMMAND_NOT_ALLOWED',
        analysis.reason ?? 'El comando no está permitido.',
      );
    }
    const base = await this.sandbox.resolveProjectBase(project.rootPath);
    const home = path.join(this.config.dataDir, 'tmp', `home-${user.id}`);
    const tmp = path.join(home, 'tmp');
    await mkdir(tmp, { recursive: true, mode: 0o700 });

    const started = Date.now();
    const maxOutput = this.config.commandMaxOutputBytes;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    return await new Promise((resolve, reject) => {
      const child = spawn(analysis.argv![0]!, analysis.argv!.slice(1), {
        cwd: base,
        shell: false,
        detached: process.platform !== 'win32',
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: home,
          TMPDIR: tmp,
          TMP: tmp,
          LANG: process.env.LANG ?? 'C.UTF-8',
          NO_COLOR: '1',
          CI: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const append = (current: string, chunk: Buffer): string => {
        if (Buffer.byteLength(current, 'utf8') >= maxOutput) {
          truncated = true;
          return current;
        }
        const remaining = maxOutput - Buffer.byteLength(current, 'utf8');
        const piece = chunk.subarray(0, Math.max(remaining, 0)).toString('utf8');
        if (piece.length < chunk.length) truncated = true;
        return current + piece;
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
        if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') >= maxOutput) {
          truncated = true;
          killTree(child.pid, 'SIGTERM');
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
        if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') >= maxOutput) {
          truncated = true;
          killTree(child.pid, 'SIGTERM');
        }
      });
      child.on('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          reject(
            new AppError(
              400,
              'COMMAND_NOT_FOUND',
              'El ejecutable no está instalado en el servidor.',
            ),
          );
          return;
        }
        reject(new AppError(500, 'COMMAND_START_FAILED', 'No se pudo iniciar el comando.'));
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        killTree(child.pid, 'SIGTERM');
        setTimeout(() => killTree(child.pid, 'SIGKILL'), 2_000).unref();
      }, this.config.commandTimeoutMs);

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({
          command: analysis.command,
          cwd: project.name,
          exitCode: code,
          signal,
          timedOut,
          truncated,
          durationMs: Date.now() - started,
          stdout: stripAnsi(stdout).trimEnd(),
          stderr: stripAnsi(stderr).trimEnd(),
        });
      });
    });
  }

  #project(user: UserRecord, projectId: string): ProjectRecord {
    const project = this.store.findProject(user.id, projectId);
    if (!project) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'El proyecto no existe o no te pertenece.');
    }
    return project;
  }
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // El proceso ya terminó.
  }
}

function stripAnsi(value: string): string {
  const escapeChar = String.fromCharCode(0x1b);
  return value.replace(new RegExp(`${escapeChar}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}
