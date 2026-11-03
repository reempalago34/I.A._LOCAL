import os from 'node:os';
import type { AppConfig } from '../config.js';
import { type LoadedModel, OllamaRuntime } from '../runtime/ollama.js';
import type { RuntimeModel, RuntimeStatus } from '../runtime/types.js';
import { type ExecutionScope, executionScope, type RuntimeTarget } from '../runtime/url-policy.js';
import { diskSpace } from '../storage/service.js';

export type PreflightLevel = 'ok' | 'warning' | 'blocked';

export interface PreflightCheck {
  id: string;
  level: PreflightLevel;
  message: string;
}

export interface HostResources {
  platform: string;
  arch: string;
  release: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  loadAverage: number[];
  uptimeSeconds: number;
}

export interface SystemResources {
  host: HostResources;
  storage: {
    dataDir: { usedBytes: number; freeBytes: number; totalBytes: number };
    projectsRoot: { usedBytes: number; freeBytes: number; totalBytes: number };
  };
  runtime: {
    url: string;
    host: string;
    location: RuntimeTarget['location'];
    executionScope: ExecutionScope;
    reachable: boolean;
    version?: string;
    loadedModels: LoadedModel[];
    gpuActive: boolean;
    error?: { code: string; message: string };
  };
  model: RuntimeModel | null;
  checks: PreflightCheck[];
  warnings: string[];
}

export async function collectSystemResources(input: {
  config: AppConfig;
  target: RuntimeTarget;
  modelName?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<SystemResources> {
  const { config, target } = input;
  const runtime = new OllamaRuntime({
    target,
    config,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const [health, loadedResult, modelResult] = await Promise.all([
    runtime
      .health(input.signal)
      .catch((error): RuntimeStatus => ({ reachable: false, error: safeError(error) })),
    runtime.loadedModels(input.signal).catch(() => null),
    input.modelName
      ? runtime.getModel(input.modelName, input.signal).catch(() => null)
      : Promise.resolve(null),
  ]);
  const loadedModels = loadedResult ?? [];
  const gpuActive = loadedModels.some((model) => model.sizeVramBytes > 0);
  const scope = executionScope(config, target);
  const dataDir = await diskSpace(config.dataDir);
  const projectsRoot = await diskSpace(config.projectsRoot);
  const host = hostResources();
  const checks: PreflightCheck[] = [];
  const warnings: string[] = [];

  if (!health.reachable) {
    checks.push({
      id: 'runtime',
      level: 'blocked',
      message: 'No se pudo contactar con el runtime. Comprueba la URL y que Ollama esté en marcha.',
    });
  } else {
    checks.push({
      id: 'runtime',
      level: 'ok',
      message: `Runtime accesible${health.version ? ` (v${health.version})` : ''}.`,
    });
  }

  if (scope === 'this-computer') {
    checks.push({
      id: 'execution',
      level: 'warning',
      message:
        'Ejecución local experimental: con 4 GB de RAM los modelos grandes no caben y los pequeños pueden ser lentos. No se descarga ningún modelo automáticamente.',
    });
    const reserve = 1.5 * 1024 ** 3;
    if (host.totalMemoryBytes < 8 * 1024 ** 3) {
      warnings.push(
        `Este equipo tiene ${formatGiB(host.totalMemoryBytes)} de RAM. Deja margen para el sistema; evita modelos que no quepan en memoria.`,
      );
    }
    if (host.freeMemoryBytes < reserve) {
      checks.push({
        id: 'memory',
        level: 'warning',
        message: `Quedan ${formatGiB(host.freeMemoryBytes)} de RAM libre. Cierra otras aplicaciones antes de cargar un modelo.`,
      });
    }
  } else {
    checks.push({
      id: 'execution',
      level: 'ok',
      message:
        'La generación se ejecuta en el servidor remoto. Este equipo solo mantiene la interfaz y envía lo que autorizas.',
    });
    checks.push({
      id: 'remote-hardware',
      level: 'warning',
      message:
        'No se puede verificar la RAM/GPU del servidor remoto solo con la URL de Ollama. Revisa `ollama ps`, `free -h` y la ficha del modelo en ese servidor.',
    });
  }

  if (input.modelName && !modelResult) {
    checks.push({
      id: 'model',
      level: 'warning',
      message: `No se pudieron leer los requisitos de "${input.modelName}". Comprueba que exista y consulta su ficha actual.`,
    });
  }

  if (modelResult) {
    const estimate = modelResult.requirements.estimatedRamBytes;
    if (estimate && (scope === 'this-computer' || target.isPrivate)) {
      const available = host.totalMemoryBytes;
      if (estimate > available * 0.8) {
        checks.push({
          id: 'model-memory',
          level: 'blocked',
          message: `La estimación del modelo (~${formatGiB(estimate)}) supera el 80 % de la RAM del host (${formatGiB(available)}). No se recomienda cargarlo aquí.`,
        });
      } else if (estimate > host.freeMemoryBytes) {
        checks.push({
          id: 'model-memory',
          level: 'warning',
          message: `La estimación del modelo (~${formatGiB(estimate)}) supera la RAM libre actual (${formatGiB(host.freeMemoryBytes)}).`,
        });
      } else {
        checks.push({
          id: 'model-memory',
          level: 'ok',
          message: `La estimación orientativa del modelo (~${formatGiB(estimate)}) cabe en la RAM libre actual. No es una garantía: depende del contexto y del runtime.`,
        });
      }
    }
    if (scope === 'this-computer' && modelResult.requirements.diskBytes > dataDir.freeBytes) {
      checks.push({
        id: 'model-disk',
        level: 'blocked',
        message: `El modelo necesita ~${formatGiB(modelResult.requirements.diskBytes)} y el disco libre es ${formatGiB(dataDir.freeBytes)}.`,
      });
    }
  }

  checks.push({
    id: 'disk',
    level: dataDir.freeBytes < 2 * 1024 ** 3 ? 'warning' : 'ok',
    message:
      dataDir.freeBytes < 2 * 1024 ** 3
        ? `Quedan ${formatGiB(dataDir.freeBytes)} libres en el volumen de datos. Libera espacio antes de guardar más datos.`
        : `Espacio libre en datos: ${formatGiB(dataDir.freeBytes)}.`,
  });

  if (loadedModels.length > 0) {
    checks.push({
      id: 'gpu',
      level: gpuActive ? 'ok' : 'warning',
      message: gpuActive
        ? `Ollama reporta VRAM en uso (${loadedModels
            .map((model) => `${model.name}: ${formatGiB(model.sizeVramBytes)}`)
            .join(', ')}).`
        : 'Ollama no reporta uso de VRAM: puede estar usando CPU. No asumas que hay GPU.',
    });
  } else {
    checks.push({
      id: 'gpu',
      level: 'warning',
      message:
        'No hay modelos cargados ahora mismo; no se puede confirmar si el servidor tiene GPU. Ejecuta una consulta y revisa `ollama ps`.',
    });
  }

  return {
    host,
    storage: { dataDir, projectsRoot },
    runtime: {
      url: target.url,
      host: `${target.hostname}:${target.port}`,
      location: target.location,
      executionScope: scope,
      reachable: health.reachable,
      ...(health.version ? { version: health.version } : {}),
      loadedModels,
      gpuActive,
      ...(health.error ? { error: health.error } : {}),
    },
    model: modelResult,
    checks,
    warnings,
  };
}

function hostResources(): HostResources {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpuModel: cpus[0]?.model ?? 'desconocido',
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    loadAverage: os.loadavg(),
    uptimeSeconds: Math.floor(os.uptime()),
  };
}

function formatGiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function safeError(error: unknown): { code: string; message: string } {
  return {
    code: 'RUNTIME_OFFLINE',
    message: error instanceof Error ? error.message : 'No se pudo contactar con el runtime.',
  };
}
