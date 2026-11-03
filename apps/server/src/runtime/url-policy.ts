import net from 'node:net';
import type { AppConfig } from '../config.js';
import { AppError } from '../utils/errors.js';

export type RuntimeLocation = 'local' | 'private' | 'remote';

export interface RuntimeTarget {
  url: string;
  hostname: string;
  port: number;
  location: RuntimeLocation;
  isLocal: boolean;
  isPrivate: boolean;
}

export function parseRuntimeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(
      400,
      'INVALID_RUNTIME_URL',
      'La dirección del runtime no es una URL válida.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'INVALID_RUNTIME_URL', 'El runtime debe usar http o https.');
  }
  if (url.username || url.password) {
    throw new AppError(
      400,
      'INVALID_RUNTIME_URL',
      'No incluyas credenciales en la URL del runtime.',
    );
  }
  if (url.search || url.hash) {
    throw new AppError(
      400,
      'INVALID_RUNTIME_URL',
      'La URL del runtime no debe incluir parámetros ni fragmentos.',
    );
  }
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url;
}

export function classifyRuntimeLocation(hostname: string): RuntimeLocation {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return 'local';
  if (host.startsWith('127.')) return 'local';

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10) return 'private';
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'remote';
    if (a === 0) return 'remote';
    return 'remote';
  }
  if (ipVersion === 6) {
    if (host.startsWith('fc') || host.startsWith('fd')) return 'private';
    if (host.startsWith('fe80')) return 'private';
    return 'remote';
  }
  if (host.endsWith('.local') || host.endsWith('.internal')) return 'private';
  // Nombres de servicio de Docker/Compose (ollama, forge-runtime, etc.) se
  // consideran privados; siguen requiriendo confirmación para enviar archivos.
  if (host === 'ollama' || host === 'forge-ollama' || host === 'host.docker.internal') {
    return 'private';
  }
  return 'remote';
}

export function resolveRuntimeTarget(raw: string, config: AppConfig): RuntimeTarget {
  const url = parseRuntimeUrl(raw);
  if (!config.allowCustomRuntime) {
    if (normalizeUrl(url) !== normalizeUrl(parseRuntimeUrl(config.defaultRuntimeUrl))) {
      throw new AppError(
        403,
        'RUNTIME_URL_NOT_ALLOWED',
        'El administrador ha fijado la dirección del runtime. No se puede cambiar.',
      );
    }
  }

  const hostname = url.hostname.toLowerCase();
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const wildcard = config.runtimeAllowedHosts.has('*');
  const hostAllowed =
    wildcard ||
    config.runtimeAllowedHosts.has(hostname) ||
    config.runtimeAllowedHosts.has(hostname.replace(/^\[|\]$/g, '')) ||
    (hostname === '127.0.0.1' && config.runtimeAllowedHosts.has('localhost'));

  if (!hostAllowed) {
    throw new AppError(
      403,
      'RUNTIME_HOST_NOT_ALLOWED',
      'El host del runtime no está en la lista permitida por el administrador.',
      { details: { allowedHosts: [...config.runtimeAllowedHosts].filter((h) => h !== '*') } },
    );
  }
  if (!config.runtimeAllowedPorts.has(port)) {
    throw new AppError(
      403,
      'RUNTIME_PORT_NOT_ALLOWED',
      'El puerto del runtime no está permitido.',
      { details: { allowedPorts: [...config.runtimeAllowedPorts] } },
    );
  }

  if (isBlockedAddress(hostname)) {
    throw new AppError(
      403,
      'RUNTIME_ADDRESS_BLOCKED',
      'La dirección del runtime está bloqueada por seguridad.',
    );
  }

  const location = classifyRuntimeLocation(hostname);
  return {
    url: normalizeUrl(url),
    hostname,
    port,
    location,
    isLocal: location === 'local',
    isPrivate: location === 'private',
  };
}

export type ExecutionScope = 'this-computer' | 'remote-server';

/**
 * Ubicación que se muestra al usuario. `deploymentMode=server` significa que la
 * interfaz se sirve desde un servidor remoto (por ejemplo Coolify), así que la
 * inferencia ocurre allí aunque Ollama sea "localhost" dentro de ese servidor.
 */
export function executionScope(config: AppConfig, target: RuntimeTarget): ExecutionScope {
  if (config.deploymentMode === 'server') return 'remote-server';
  return target.isLocal ? 'this-computer' : 'remote-server';
}

export function isBlockedAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '0.0.0.0' || host === '::' || host === 'metadata.google.internal') return true;
  if (host === '169.254.169.254' || host === '100.100.100.200') return true;
  return false;
}

function normalizeUrl(url: URL): string {
  const copy = new URL(url.toString());
  copy.search = '';
  copy.hash = '';
  if (copy.pathname.length > 1) copy.pathname = copy.pathname.replace(/\/+$/, '');
  return copy.toString().replace(/\/$/, '');
}

export function joinRuntimeUrl(base: string, pathname: string): string {
  return `${base.replace(/\/$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
