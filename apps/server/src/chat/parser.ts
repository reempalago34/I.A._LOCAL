import { normalizeRelativePath } from '../files/paths.js';
import { AppError } from '../utils/errors.js';

export interface ParsedProposal {
  path: string;
  action: 'write' | 'delete';
  content: string;
}

export interface ParsedCommand {
  command: string;
  reason?: string;
}

export interface ParsedAssistantOutput {
  proposals: ParsedProposal[];
  commands: ParsedCommand[];
  displayContent: string;
  warnings: string[];
}

const MAX_PROPOSALS = 20;
const MAX_PROPOSAL_BYTES = 524_288;
const MAX_TOTAL_BYTES = 1_048_576;
const MAX_COMMANDS = 5;

const PROPOSAL_TAG = /<proposal\s+([^>]*)>([\s\S]*?)<\/proposal>/gi;
const PROPOSAL_FENCE = /```(?:file|proposal):([^\n`]+)\n([\s\S]*?)```/gi;
const COMMAND_TAG = /<command(?:[^>]*)>([\s\S]*?)<\/command>/gi;

export function parseAssistantOutput(raw: string): ParsedAssistantOutput {
  const proposals: ParsedProposal[] = [];
  const commands: ParsedCommand[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;

  const addProposal = (attributes: string, rawContent: string, fallbackPath?: string): void => {
    if (proposals.length >= MAX_PROPOSALS) {
      if (!warnings.includes(`Se ignoraron propuestas adicionales (máximo ${MAX_PROPOSALS}).`)) {
        warnings.push(`Se ignoraron propuestas adicionales (máximo ${MAX_PROPOSALS}).`);
      }
      return;
    }
    const pathMatch = attributes.match(/(?:^|\s)path\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
    const actionMatch = attributes.match(/(?:^|\s)action\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
    const rawPath = fallbackPath ?? pathMatch?.[1] ?? pathMatch?.[2] ?? pathMatch?.[3];
    if (!rawPath) {
      warnings.push('Se ignoró una propuesta sin ruta de archivo.');
      return;
    }
    let relativePath: string;
    try {
      relativePath = normalizeRelativePath(rawPath.trim(), false);
    } catch {
      warnings.push(`Se bloqueó una propuesta con ruta inválida: ${rawPath.slice(0, 120)}`);
      return;
    }
    if (seenPaths.has(relativePath)) {
      warnings.push(`Se ignoró una propuesta duplicada para ${relativePath}.`);
      return;
    }
    const actionRaw = (actionMatch?.[1] ?? actionMatch?.[2] ?? actionMatch?.[3] ?? 'write')
      .toLowerCase()
      .trim();
    if (actionRaw !== 'write' && actionRaw !== 'delete') {
      warnings.push(`Acción no soportada en ${relativePath}; se usará "write".`);
    }
    const content = actionRaw === 'delete' ? '' : stripLeadingNewline(rawContent);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_PROPOSAL_BYTES) {
      warnings.push(`La propuesta para ${relativePath} supera el tamaño máximo y se ignoró.`);
      return;
    }
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      warnings.push('Se alcanzó el tamaño máximo total de propuestas; algunas se ignoraron.');
      return;
    }
    totalBytes += bytes;
    seenPaths.add(relativePath);
    proposals.push({
      path: relativePath,
      action: actionRaw === 'delete' ? 'delete' : 'write',
      content,
    });
  };

  for (const match of raw.matchAll(PROPOSAL_TAG)) {
    addProposal(match[1] ?? '', match[2] ?? '');
  }
  for (const match of raw.matchAll(PROPOSAL_FENCE)) {
    const fallbackPath = (match[1] ?? '').trim();
    addProposal('', match[2] ?? '', fallbackPath);
  }

  for (const match of raw.matchAll(COMMAND_TAG)) {
    if (commands.length >= MAX_COMMANDS) {
      warnings.push(`Se ignoraron comandos adicionales (máximo ${MAX_COMMANDS}).`);
      break;
    }
    const command = (match[1] ?? '').trim().split('\n')[0]?.trim() ?? '';
    if (!command) continue;
    if (command.length > 500) {
      warnings.push('Se ignoró un comando demasiado largo.');
      continue;
    }
    commands.push({ command });
  }

  let displayContent = raw.replace(PROPOSAL_TAG, '').replace(PROPOSAL_FENCE, '');
  displayContent = displayContent.replace(COMMAND_TAG, '');
  displayContent = displayContent.replace(/\n{3,}/g, '\n\n').trim();
  if (proposals.length > 0) {
    displayContent += `\n\n${proposals
      .map((proposal) =>
        proposal.action === 'delete'
          ? `_Propuesta para eliminar \`${proposal.path}\` (revisar en el panel de cambios)._`
          : `_Propuesta de cambio para \`${proposal.path}\` (revisar en el panel de cambios)._`,
      )
      .join('\n')}`;
  }
  if (commands.length > 0) {
    displayContent += `\n\n_${commands.length} comando(s) propuesto(s). Ninguno se ejecuta automáticamente._`;
  }

  return {
    proposals,
    commands,
    displayContent: displayContent.trim(),
    warnings,
  };
}

export function validateCommandText(command: string): {
  ok: boolean;
  reason?: string;
  argv?: string[];
} {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: 'Comando vacío.' };
  if (trimmed.length > 500) return { ok: false, reason: 'Comando demasiado largo.' };
  if (/(?:^|\s)[a-zA-Z]:[\\/]/.test(trimmed) || /(?:^|\s)\\\\[^\\s]/.test(trimmed)) {
    return { ok: false, reason: 'No se permiten rutas absolutas en los argumentos.' };
  }
  if (/[\0\r\n]/.test(trimmed)) {
    return { ok: false, reason: 'El comando contiene saltos de línea o caracteres de control.' };
  }
  if (/[;&|><`$]/.test(trimmed)) {
    return {
      ok: false,
      reason: 'No se permiten operadores de shell, redirecciones, variables ni sustitución.',
    };
  }
  let argv: string[];
  try {
    argv = tokenizeCommand(trimmed);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Comando inválido.' };
  }
  if (argv.length === 0) return { ok: false, reason: 'Comando vacío.' };
  if (argv[0]!.includes('=')) {
    return { ok: false, reason: 'No se permiten asignaciones de entorno.' };
  }
  for (const arg of argv.slice(1)) {
    if (arg.includes('\0')) return { ok: false, reason: 'Argumento inválido.' };
    if (arg.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(arg)) {
      return { ok: false, reason: 'No se permiten rutas absolutas en los argumentos.' };
    }
    if (arg.split(/[\\/]/).includes('..')) {
      return { ok: false, reason: 'No se permiten rutas con "..".' };
    }
    if (/^--?(?:git-dir|work-tree|exec-path|upload-pack|receive-pack)/i.test(arg)) {
      return { ok: false, reason: 'Opción de git no permitida.' };
    }
  }
  return { ok: true, argv };
}

function tokenizeCommand(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (quote) throw new AppError(400, 'INVALID_COMMAND', 'Comillas sin cerrar en el comando.');
  if (current) result.push(current);
  return result;
}

function stripLeadingNewline(value: string): string {
  return value.startsWith('\r\n')
    ? value.slice(2)
    : value.startsWith('\n')
      ? value.slice(1)
      : value;
}
