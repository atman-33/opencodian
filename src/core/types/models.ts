/**
 * Model and Provider types for Opencodian
 *
 * Types are based on OpenCode SDK API responses.
 * GET /config/providers returns user-configured providers with their models.
 */

/** Model capabilities */
export interface ModelCapabilities {
  temperature: boolean;
  reasoning: boolean;
  attachment: boolean;
  toolcall: boolean;
  input: {
    text: boolean;
    audio: boolean;
    image: boolean;
    video: boolean;
    pdf: boolean;
  };
  output: {
    text: boolean;
    audio: boolean;
    image: boolean;
    video: boolean;
    pdf: boolean;
  };
}

/** Model cost information */
export interface ModelCost {
  input: number;
  output: number;
  cache?: {
    read: number;
    write: number;
  };
}

/** Model from OpenCode API */
export interface ProviderModel {
  id: string;
  providerID: string;
  name: string;
  family?: string;
  capabilities?: ModelCapabilities;
  cost?: ModelCost;
  limit?: {
    context: number;
    input?: number;
    output: number;
  };
  status?: "alpha" | "beta" | "deprecated" | "active";
}

/** Provider from OpenCode API */
export interface Provider {
  id: string;
  name: string;
  source: "env" | "config" | "custom" | "api";
  env?: string[];
  models: Record<string, ProviderModel>;
}

/**
 * Response from GET /config/providers endpoint
 * Returns only user-configured/connected providers
 */
export interface ConfigProvidersResponse {
  providers: Provider[];
  default: Record<string, string>;
}

/** Response from GET /provider endpoint (all providers) - not used */
export interface ProviderListResponse {
  all: Provider[];
  default: Record<string, string>;
  connected: string[];
}

/** Simplified model option for UI */
export interface ModelOption {
  id: string; // Format: provider/model-id
  label: string;
  providerID: string;
  isFree: boolean;
}

/** Provider with processed models for UI */
export interface ProviderWithModels {
  id: string;
  name: string;
  isConnected: boolean;
  models: ModelOption[];
  defaultModelId?: string;
}

export interface ProviderProcessingSummary {
  providerId: string;
  providerName: string;
  rawModelCount: number;
  processedModelCount: number;
  filteredOutModelIds: string[];
  rawModelIds: string[];
  processedModelIds: string[];
}

export interface ProcessProvidersResult {
  providers: ProviderWithModels[];
  summaries: ProviderProcessingSummary[];
}

/** Popular providers (shown first in list) */
export const POPULAR_PROVIDERS = [
  "opencode",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
];

/** Legacy: Free models available in Opencodian (from OpenCode Zen) */
export const FREE_MODELS: ModelOption[] = [
  {
    id: "opencode/big-pickle",
    label: "Big Pickle",
    providerID: "opencode",
    isFree: true,
  },
  {
    id: "opencode/grok-code",
    label: "Grok Code",
    providerID: "opencode",
    isFree: true,
  },
];

/** Default model */
export const DEFAULT_MODEL = FREE_MODELS[0];

/** Get model by ID */
export function getModelById(id: string): ModelOption | undefined {
  return FREE_MODELS.find((m) => m.id === id);
}

/** Get model label by ID */
export function getModelLabel(id: string): string {
  const model = getModelById(id);
  return model?.label || id;
}

/**
 * Check if model is free.
 *
 * OpenCode's providers list may omit `cost` or report zeros.
 * We only show the Free badge for a small allowlist.
 */
export function isModelFree(model: ProviderModel): boolean {
  const id = `${model.providerID}/${model.id}`;
  return id === "opencode/big-pickle" || id === "opencode/grok-code";
}

/** Convert API model to UI model option */
export function toModelOption(model: ProviderModel): ModelOption {
  return {
    id: `${model.providerID}/${model.id}`,
    label: model.name,
    providerID: model.providerID,
    isFree: isModelFree(model),
  };
}

/** Process config providers response to UI-friendly format */
export function processProviders(
  response: ConfigProvidersResponse
): ProcessProvidersResult {
  const providers: ProviderWithModels[] = [];
  const summaries: ProviderProcessingSummary[] = [];

  for (const provider of response.providers) {
    const rawModels = Object.values(provider.models);
    const visibleModels = rawModels.filter(
      (m) => !(provider.id === "opencode" && m.id.includes("gpt-5-nano"))
    );
    const models = visibleModels.map(toModelOption);
    const rawModelIds = rawModels.map((m) => `${m.providerID}/${m.id}`);
    const processedModelIds = models.map((m) => m.id);
    const filteredOutModelIds = rawModelIds.filter(
      (id) => !processedModelIds.includes(id)
    );

    // Sort models: Free first, then active/other, then by name
    models.sort((a, b) => {
      // Free models always first
      if (a.isFree !== b.isFree) {
        return a.isFree ? -1 : 1;
      }
      return a.label.localeCompare(b.label);
    });

    providers.push({
      id: provider.id,
      name: provider.name,
      isConnected: true, // All providers from /config/providers are connected
      models,
      defaultModelId: response.default[provider.id],
    });

    summaries.push({
      providerId: provider.id,
      providerName: provider.name,
      rawModelCount: rawModels.length,
      processedModelCount: models.length,
      filteredOutModelIds,
      rawModelIds,
      processedModelIds,
    });
  }

  // Sort providers: popular first, then alphabetically
  providers.sort((a, b) => {
    const aPopular = POPULAR_PROVIDERS.indexOf(a.id);
    const bPopular = POPULAR_PROVIDERS.indexOf(b.id);
    if (aPopular !== -1 && bPopular !== -1) {
      return aPopular - bPopular;
    }
    if (aPopular !== -1) return -1;
    if (bPopular !== -1) return 1;

    return a.name.localeCompare(b.name);
  });

  return {
    providers,
    summaries,
  };
}
