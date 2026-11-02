export const DEFAULT_AGENT_MODEL = 'deepseek-v4-1-flash-261017';
export const DEFAULT_VISION_MODEL = 'doubao-seed-evolving';
export const MAX_CONFIGURED_OUTPUT = 1_024_000;
// Official Ark model-list / DeepSeek / Seed-Evolving docs, checked 2026-11-02.
// A configured ceiling is not a request to fill the whole response.
const profiles: Record<string, { label: string; context: number; output: number; limit: number }> =
  {
    [DEFAULT_AGENT_MODEL]: {
      label: 'DeepSeek V4.1 Flash',
      context: 1_024_000,
      output: 128_000,
      limit: 384_000,
    },
    [DEFAULT_VISION_MODEL]: {
      label: 'Doubao Seed Evolving',
      context: 1_024_000,
      output: 8192,
      limit: 256_000,
    },
    'doubao-seed-2-1-pro-260915': {
      label: 'Doubao Seed 2.1 Pro',
      context: 1_024_000,
      output: 8192,
      limit: 256_000,
    },
    'doubao-seed-2-1-lite-260915': {
      label: 'Doubao Seed 2.1 Lite',
      context: 1_024_000,
      output: 8192,
      limit: 256_000,
    },
  };
export function modelDefaults(modelId = DEFAULT_AGENT_MODEL) {
  const p = profiles[modelId];
  return {
    label: p?.label || modelId,
    contextWindowTokens: p?.context || 64000,
    maxOutputTokens: p?.output || 8192,
    outputLimit: p?.limit || MAX_CONFIGURED_OUTPUT,
  };
}
/** Same reserve in the SDK, gateway and history projection; SDK also measures actual input room. */
export function outputTokenBudget(contextWindow = 64000, requested = 8192, modelId?: string) {
  return Math.min(
    modelId ? modelDefaults(modelId).outputLimit : MAX_CONFIGURED_OUTPUT,
    Math.max(1024, requested),
    Math.max(1024, contextWindow - 8192),
  );
}
