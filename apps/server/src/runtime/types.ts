export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalDurationMs?: number;
  /** `done_reason` de Ollama: `stop` o `length` (límite de salida). */
  doneReason?: string;
}

export type ChatStreamChunk = { type: 'delta'; text: string } | { type: 'done'; usage: ChatUsage };

export interface RuntimeModelDetails {
  format?: string;
  family?: string;
  families?: string[];
  parameterSize?: string;
  quantizationLevel?: string;
}

export interface RuntimeModelCapabilities {
  contextLength?: number;
  parameterCount?: number;
  embeddingLength?: number;
  capabilities?: string[];
}

export interface RuntimeModel {
  name: string;
  sizeBytes: number;
  digest?: string;
  modifiedAt?: string;
  details: RuntimeModelDetails;
  capabilities: RuntimeModelCapabilities;
  requirements: ModelRequirements;
}

export interface ModelRequirements {
  diskBytes: number;
  estimatedRamBytes: number | null;
  estimateQuality: 'rough' | 'unknown';
  notes: string[];
}

export interface RuntimeStatus {
  reachable: boolean;
  version?: string;
  modelCount?: number;
  error?: { code: string; message: string };
}

export interface ModelRuntime {
  readonly kind: string;
  readonly target: string;
  health(signal?: AbortSignal): Promise<RuntimeStatus>;
  listModels(signal?: AbortSignal): Promise<RuntimeModel[]>;
  getModel(name: string, signal?: AbortSignal): Promise<RuntimeModel>;
  chat(
    request: { model: string; messages: ChatMessage[] },
    signal: AbortSignal,
  ): AsyncGenerator<ChatStreamChunk, void, unknown>;
}
