import { tokenizeCommand, validateCommandText } from '../chat/parser.js';

/**
 * Allowlist por defecto: solo comandos completos y, siempre que sea posible,
 * de lectura. No se incluyen binarios sueltos: una entrada debe tener al menos
 * dos tokens (`git status`, `npm --version`) para evitar habilitar por accidente
 * todas las invocaciones de un ejecutable.
 */
export const DEFAULT_COMMAND_ALLOWLIST =
  'git status,git diff,git log,git show,git rev-parse,git ls-files,node --version,npm --version';

/** Subcomandos de git que no ejecutan hooks ni programas externos conocidos. */
const SAFE_GIT_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'check-attr',
  'check-ignore',
  'count-objects',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'version',
  'whatchanged',
]);

/**
 * Opciones de git que permiten cambiar la configuración, el directorio de
 * trabajo, el ejecutable de transporte o el programa que interpreta el
 * repositorio. Se deniegan aunque aparezcan en una entrada de la allowlist.
 */
const GIT_DENIED_OPTION =
  /^(?:-c|--config-env(?:=|$)|--exec-path(?:=|$)|--upload-pack(?:=|$)|--receive-pack(?:=|$)|--git-dir(?:=|$)|--work-tree(?:=|$)|-C(?:$|.))/i;

/** Opciones de git que pueden lanzar un programa externo (diff, pager, textconv). */
const GIT_DENIED_PROGRAM_OPTION =
  /^(?:--ext-diff(?:=|$)|--textconv(?:=|$)|--open-files-in-pager(?:=|$)|--paginate(?:=|$)|-p(?:$|.)|-O(?:$|.))/i;

export interface CommandCheck {
  ok: boolean;
  reason?: string;
  argv?: string[];
  /** El comando ejecuta scripts de package.json (test/start/run). */
  executesScripts: boolean;
}

/**
 * Normaliza una entrada de `COMMAND_ALLOWLIST`. Se ignoran entradas vacías,
 * demasiado largas o con un solo token: un binario suelto habilitaría todos sus
 * subcomandos y argumentos.
 */
export function normalizeAllowlistEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed || trimmed.length > 200 || trimmed.includes('\0')) return null;
  let argv: string[];
  try {
    argv = tokenizeCommand(trimmed);
  } catch {
    return null;
  }
  if (argv.length < 2) return null;
  return argv.join(' ');
}

export function parseCommandAllowlist(value: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const item of value.split(',')) {
    const normalized = normalizeAllowlistEntry(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push(normalized);
    if (entries.length >= 100) break;
  }
  return entries;
}

/**
 * Coincidencia por prefijo de tokens, sensible a mayúsculas porque los
 * ejecutables y opciones de Unix lo son. `git status` permite
 * `git status --short`, pero no `git statusx` ni `GIT STATUS`.
 */
export function matchesCommandAllowlist(
  argv: readonly string[],
  allowlist: readonly string[],
): boolean {
  if (argv.length === 0) return false;
  for (const entry of allowlist) {
    let tokens: string[];
    try {
      tokens = tokenizeCommand(entry);
    } catch {
      continue;
    }
    if (tokens.length < 2 || tokens.length > argv.length) continue;
    if (tokens.every((token, index) => token === argv[index])) return true;
  }
  return false;
}

/** El comando ejecuta scripts definidos en package.json. */
export function commandExecutesScripts(argv: readonly string[]): boolean {
  if (argv[0] !== 'npm') return false;
  const subcommand = (argv[1] ?? '').toLowerCase();
  return ['test', 't', 'start', 'run', 'run-script', 'stop', 'restart'].includes(subcommand);
}

/**
 * Aplica las reglas independientes de la allowlist: operadores de shell,
 * `node -e`/`--eval`/`-p`/`--print`, `npx`, instalaciones de npm, opciones
 * peligrosas de git y subcomandos de git que pueden ejecutar hooks o alias.
 */
export function checkCommand(command: string, allowlist: readonly string[]): CommandCheck {
  const validation = validateCommandText(command);
  if (!validation.ok || !validation.argv) {
    return { ok: false, reason: validation.reason, executesScripts: false };
  }
  const argv = validation.argv;
  const universal = universalDenial(argv);
  if (universal) return { ok: false, reason: universal, argv, executesScripts: false };
  if (!matchesCommandAllowlist(argv, allowlist)) {
    return {
      ok: false,
      reason:
        'El comando no coincide con ningún comando completo permitido en COMMAND_ALLOWLIST. Añade la invocación exacta (por ejemplo, "npm test") si quieres habilitarla.',
      argv,
      executesScripts: commandExecutesScripts(argv),
    };
  }
  return { ok: true, argv, executesScripts: commandExecutesScripts(argv) };
}

export function describeCommandEffects(executesScripts: boolean): string {
  const base =
    'Se ejecutaría dentro de la carpeta del proyecto con un entorno mínimo. No hay aislamiento de contenedor desde la aplicación.';
  return executesScripts
    ? `${base} Ejecuta scripts de package.json: esos scripts pueden modificar archivos, instalar dependencias o consumir recursos. Revisa package.json y los scripts antes de aprobar.`
    : `${base} La allowlist solo debería incluir comandos de confianza; revisa el comando y sus argumentos antes de aprobarlo.`;
}

function universalDenial(argv: string[]): string | null {
  const binary = (argv[0] ?? '').toLowerCase();
  const args = argv.slice(1);

  if (binary === 'npx') {
    return 'npx puede descargar y ejecutar paquetes arbitrarios; no está permitido.';
  }

  if (binary === 'node' || binary === 'nodejs') {
    for (const arg of args) {
      if (/^--(?:eval|print)(?:=|$)/i.test(arg) || /^-[^-]*[ep][^-]*$/i.test(arg)) {
        return 'node no puede usarse con -e/--eval ni -p/--print porque ejecuta código arbitrario.';
      }
    }
  }

  if (binary === 'npm') {
    const subcommand = (args[0] ?? '').toLowerCase();
    if (
      [
        'exec',
        'x',
        'install',
        'i',
        'in',
        'ins',
        'inst',
        'insta',
        'instal',
        'isntall',
        'install-test',
        'it',
        'install-ci-test',
        'cit',
        'ci',
        'clean-install',
        'ic',
        'clean-install-test',
        'add',
        'update',
        'up',
        'upgrade',
        'udpate',
        'rebuild',
        'rb',
        'link',
        'ln',
      ].includes(subcommand)
    ) {
      return `"npm ${subcommand}" puede instalar o ejecutar paquetes y no está permitido.`;
    }
  }

  if (binary === 'git') {
    for (const arg of args) {
      if (GIT_DENIED_OPTION.test(arg)) {
        return 'Opción de git no permitida: puede cambiar configuración, rutas o programas externos.';
      }
      if (GIT_DENIED_PROGRAM_OPTION.test(arg)) {
        return 'Opción de git no permitida: puede ejecutar un programa externo.';
      }
    }
    const subcommand = args.find((arg) => !arg.startsWith('-'));
    if (!subcommand) {
      return 'Indica un subcomando de git permitido (por ejemplo, "git status").';
    }
    if (!SAFE_GIT_SUBCOMMANDS.has(subcommand.toLowerCase())) {
      return `El subcomando git "${subcommand}" no está permitido: puede ejecutar hooks, alias o programas externos.`;
    }
  }

  return null;
}
