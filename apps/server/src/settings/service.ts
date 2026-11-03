import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Store } from '../db.js';
import { sanitizePatterns } from '../files/exclusions.js';
import { resolveRuntimeTarget } from '../runtime/url-policy.js';
import type { SettingsData } from '../types.js';
import { AppError } from '../utils/errors.js';

const languageSchema = z.enum(['es', 'en']);
const themeSchema = z.enum(['system', 'light', 'dark']);

export function defaultSettings(config: AppConfig): SettingsData {
  return {
    runtimeUrl: config.defaultRuntimeUrl,
    defaultModel: '',
    persistHistory: false,
    language: 'es',
    theme: 'system',
    maxFileBytes: config.maxFileBytes,
    maxContextBytes: config.maxContextBytes,
    maxContextFiles: config.maxContextFiles,
    maxStorageBytes: config.maxStorageBytes,
    excludePatterns: [],
  };
}

function settingsSchema(config: AppConfig) {
  return z.object({
    runtimeUrl: z.string().min(1).max(2048),
    defaultModel: z
      .string()
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/, 'Nombre de modelo inválido.')
      .or(z.literal('')),
    persistHistory: z.boolean(),
    language: languageSchema,
    theme: themeSchema,
    maxFileBytes: z.number().int().min(1_024).max(config.maxFileBytes),
    maxContextBytes: z.number().int().min(1_024).max(config.maxContextBytes),
    maxContextFiles: z.number().int().min(1).max(config.maxContextFiles),
    maxStorageBytes: z.number().int().min(1_048_576).max(config.maxStorageBytes),
    excludePatterns: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .refine((value) => !value.startsWith('!'), 'Las negaciones no están permitidas.'),
      )
      .max(100),
  });
}

export class SettingsService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {}

  get(userId: string): SettingsData {
    const defaults = defaultSettings(this.config);
    const stored = this.store.getSettings(userId);
    if (!stored) return defaults;
    const merged = {
      ...defaults,
      ...stored,
      excludePatterns: sanitizePatterns(stored.excludePatterns ?? []),
    };
    const parsed = settingsSchema(this.config).safeParse(merged);
    if (!parsed.success) {
      return defaults;
    }
    return parsed.data;
  }

  update(userId: string, patch: unknown): SettingsData {
    const current = this.get(userId);
    const body = z
      .object({
        runtimeUrl: z.string().min(1).max(2048).optional(),
        defaultModel: z
          .string()
          .max(200)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/, 'Nombre de modelo inválido.')
          .or(z.literal(''))
          .optional(),
        persistHistory: z.boolean().optional(),
        language: languageSchema.optional(),
        theme: themeSchema.optional(),
        maxFileBytes: z.number().int().optional(),
        maxContextBytes: z.number().int().optional(),
        maxContextFiles: z.number().int().optional(),
        maxStorageBytes: z.number().int().optional(),
        excludePatterns: z.array(z.string()).max(100).optional(),
      })
      .strict()
      .parse(patch);

    const next: SettingsData = {
      ...current,
      ...(body.language !== undefined ? { language: body.language } : {}),
      ...(body.theme !== undefined ? { theme: body.theme } : {}),
      ...(body.persistHistory !== undefined ? { persistHistory: body.persistHistory } : {}),
      ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
      ...(body.maxFileBytes !== undefined ? { maxFileBytes: body.maxFileBytes } : {}),
      ...(body.maxContextBytes !== undefined ? { maxContextBytes: body.maxContextBytes } : {}),
      ...(body.maxContextFiles !== undefined ? { maxContextFiles: body.maxContextFiles } : {}),
      ...(body.maxStorageBytes !== undefined ? { maxStorageBytes: body.maxStorageBytes } : {}),
      ...(body.excludePatterns !== undefined
        ? { excludePatterns: sanitizePatterns(body.excludePatterns) }
        : {}),
    };

    if (next.maxContextBytes < next.maxFileBytes) {
      throw new AppError(
        400,
        'INVALID_LIMITS',
        'El límite total de contexto debe ser mayor o igual que el límite por archivo.',
      );
    }

    if (body.runtimeUrl !== undefined) {
      const target = resolveRuntimeTarget(body.runtimeUrl, this.config);
      next.runtimeUrl = target.url;
    }

    const parsed = settingsSchema(this.config).safeParse(next);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_SETTINGS', 'La configuración no es válida.', {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    }
    this.store.saveSettings(userId, parsed.data, Date.now());
    return parsed.data;
  }

  reset(userId: string): SettingsData {
    const defaults = defaultSettings(this.config);
    this.store.saveSettings(userId, defaults, Date.now());
    return defaults;
  }
}
