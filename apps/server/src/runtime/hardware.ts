import type { ModelRequirements } from './types.js';

const GIB = 1024 ** 3;

export function parseParameterCount(input?: {
  parameterCount?: number;
  parameterSize?: string;
}): number | null {
  if (input?.parameterCount && Number.isFinite(input.parameterCount) && input.parameterCount > 0) {
    return input.parameterCount;
  }
  const raw = input?.parameterSize?.trim().toUpperCase();
  if (!raw) return null;
  const moe = raw.match(/^(\d+)X([\d.]+)\s*B$/);
  if (moe) {
    const experts = Number(moe[1]);
    const perExpert = Number(moe[2]);
    if (experts > 0 && perExpert > 0) return experts * perExpert * 1e9;
  }
  const match = raw.match(/^([\d.]+)\s*([BM])$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return match[2] === 'B' ? amount * 1e9 : amount * 1e6;
}

export function bytesPerParameter(quantization?: string): number {
  const quant = quantization?.toUpperCase() ?? '';
  if (quant.includes('Q2')) return 0.35;
  if (quant.includes('Q3')) return 0.45;
  if (quant.includes('Q4')) return 0.58;
  if (quant.includes('Q5')) return 0.7;
  if (quant.includes('Q6')) return 0.85;
  if (quant.includes('Q8')) return 1.05;
  if (quant.includes('F32')) return 4;
  if (quant.includes('F16') || quant.includes('BF16')) return 2;
  return 0.65;
}

export function estimateRequirements(input: {
  sizeBytes: number;
  parameterCount?: number;
  parameterSize?: string;
  quantizationLevel?: string;
  contextLength?: number;
}): ModelRequirements {
  const params = parseParameterCount(input);
  const notes = [
    'Estimación orientativa; el consumo real depende del runtime, GPU/CPU, contexto y cuantización.',
    'El espacio en disco debe reservarse en el volumen persistente de modelos.',
  ];
  if (!params) {
    return {
      diskBytes: input.sizeBytes,
      estimatedRamBytes: null,
      estimateQuality: 'unknown',
      notes: [...notes, 'No se pudo inferir el número de parámetros del modelo.'],
    };
  }
  const weightsBytes = params * bytesPerParameter(input.quantizationLevel);
  const context = Math.max(input.contextLength ?? 8_192, 2_048);
  // Aproximación muy conservadora de KV cache + overhead del runtime.
  const contextOverhead = (params / 1e9) * 0.00008 * (context / 8_192) * GIB;
  const runtimeOverhead = 0.75 * GIB;
  const estimatedRamBytes = Math.ceil(weightsBytes * 1.18 + contextOverhead + runtimeOverhead);
  return {
    diskBytes: input.sizeBytes,
    estimatedRamBytes,
    estimateQuality: 'rough',
    notes,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'desconocido';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}
