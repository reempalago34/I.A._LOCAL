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

const PROPOSAL_FENCE = /```(?:file|proposal):([^\n`]+)\n([\s\S]*?)```/gi;
const COMMAND_TAG = /<command(?:[^>]*)>([\s\S]*?)<\/command>/gi;

interface ProposalBlock {
  attributes: string;
  content: string;
  start: number;
  end: number;
}

/**
 * Busca etiquetas de propuesta de forma secuencial.
 *
 * Regla de cierre: dentro del bloque delimitado por la siguiente etiqueta
 * `<proposal ...>` (o el final del texto), se usa el **último** `</proposal>`.
 * Así el contenido puede incluir la cadena `</proposal>` sin cerrar la propuesta
 * antes de tiempo. Límite conocido: el contenido no puede incluir una etiqueta
 * de apertura `<proposal ...>` literal antes del cierre real, porque se
 * interpretaría como el inicio de otra propuesta.
 */
function scanProposalTags(raw: string): { blocks: ProposalBlock[]; unclosed: boolean } {
  const blocks: ProposalBlock[] = [];
  let cursor = 0;
  let unclosed = false;

  while (cursor < raw.length) {
    const openStart = findOpeningTag(raw, cursor);
    if (openStart === -1) break;
    const openEnd = raw.indexOf('>', openStart);
    if (openEnd === -1) {
      unclosed = true;
      break;
    }
    const attributes = raw.slice(openStart + '<proposal'.length, openEnd);
    const nextOpen = findOpeningTag(raw, openEnd + 1);
    const regionEnd = nextOpen === -1 ? raw.length : nextOpen;
    const close = findLastClosingTag(raw, openEnd + 1, regionEnd);
    if (!close) {
      unclosed = true;
      cursor = regionEnd;
      continue;
    }
    blocks.push({
      attributes,
      content: raw.slice(openEnd + 1, close.start),
      start: openStart,
      end: close.end,
    });
    cursor = close.end;
  }

  return { blocks, unclosed };
}

function findOpeningTag(raw: string, from: number): number {
  const pattern = /<proposal(?=[\s>])/gi;
  pattern.lastIndex = from;
  return pattern.exec(raw)?.index ?? -1;
}

function findLastClosingTag(
  raw: string,
  from: number,
  to: number,
): { start: number; end: number } | null {
  const pattern = /<\/proposal\s*>/gi;
  const region = raw.slice(from, to);
  let last: RegExpExecArray | null = null;
  for (const match of region.matchAll(pattern)) {
    last = match;
  }
  if (!last || last.index === undefined) return null;
  return { start: from + last.index, end: from + last.index + last[0].length };
}

function overlaps(
  spans: readonly { start: number; end: number }[],
  start: number,
  end: number,
): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

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
      warnings.push(
        `Acción no soportada en ${relativePath} ("${actionRaw.slice(0, 40)}"); se ignoró la propuesta.`,
      );
      return;
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
      action: actionRaw,
      content,
    });
  };

  const tagScan = scanProposalTags(raw);
  for (const block of tagScan.blocks) {
    addProposal(block.attributes, block.content);
  }
  if (tagScan.unclosed) {
    warnings.push(
      'Se ignoró una propuesta sin etiqueta de cierre </proposal>; la respuesta puede estar incompleta.',
    );
  }

  const tagSpans = tagScan.blocks.map(({ start, end }) => ({ start, end }));
  const fenceSpans: { start: number; end: number }[] = [];
  for (const match of raw.matchAll(PROPOSAL_FENCE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(tagSpans, start, end)) continue;
    fenceSpans.push({ start, end });
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

  let displayContent = removeSpans(raw, [...tagSpans, ...fenceSpans]);
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

function removeSpans(raw: string, spans: readonly { start: number; end: number }[]): string {
  if (spans.length === 0) return raw;
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  let result = raw;
  for (const span of ordered) {
    result = result.slice(0, span.start) + result.slice(span.end);
  }
  return result;
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

export function tokenizeCommand(input: string): string[] {
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
