import 'dotenv/config';

export type Provider = 'meta' | 'baseten';

export interface LLMConfig {
  provider: Provider;
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface AgentConfig {
  maxSteps: number;
  headless: boolean;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

/** Reads the model provider settings from .env and fails loudly if something is missing. */
export function getLLMConfig(): LLMConfig {
  const provider = (process.env.LLM_PROVIDER ?? 'baseten') as Provider;
  if (provider !== 'meta' && provider !== 'baseten') {
    throw new Error(`LLM_PROVIDER must be "meta" or "baseten", got "${provider}"`);
  }

  const settings =
    provider === 'baseten'
      ? {
          baseURL: process.env.BASETEN_BASE_URL || 'https://inference.baseten.co/v1',
          apiKey: process.env.BASETEN_API_KEY ?? '',
          model: process.env.BASETEN_MODEL || 'meta-models/muse-spark-open-1026',
        }
      : {
          baseURL: process.env.META_BASE_URL ?? '',
          apiKey: process.env.META_API_KEY ?? '',
          model: process.env.META_MODEL ?? '',
        };

  const missing = Object.entries(settings)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Missing settings for provider "${provider}": ${missing.join(', ')}. Fill them in .env (see .env.example).`,
    );
  }

  return { provider, ...settings, maxTokens: intEnv('MAX_TOKENS', 4096) };
}

export function getAgentConfig(): AgentConfig {
  return {
    maxSteps: intEnv('MAX_STEPS', 25),
    headless: (process.env.HEADLESS ?? 'true') !== 'false',
  };
}

export function getUiPort(): number {
  const raw = process.env.UI_PORT;
  if (!raw) return 5174;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0 || n > 65535) {
    throw new Error(`UI_PORT must be a valid port, got "${raw}"`);
  }
  return n;
}
