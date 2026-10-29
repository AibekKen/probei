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

export interface UiConfig {
  port: number;
  host: string;
  /** Origins allowed to start runs from a browser. Requests without an Origin header (curl, CLI) pass. */
  allowedOrigins: string[];
  /** When set, every UI request needs HTTP Basic auth with this password (any user name). */
  password: string;
  /** Upper bound for maxSteps sent by the UI. */
  maxSteps: number;
  /** false: the agent may not open localhost, private networks or cloud metadata addresses. */
  allowPrivateUrls: boolean;
  /** How often the server checks watched projects for a new deploy (ms). */
  deployPollMs: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** UI server settings. Defaults are safe for a laptop; a public server sets HOST=0.0.0.0. */
export function getUiConfig(): UiConfig {
  const port = getUiPort();
  const host = process.env.HOST || '127.0.0.1';
  const local = LOOPBACK_HOSTS.has(host);
  const origins = (process.env.ALLOWED_ORIGIN || `http://localhost:${port},http://127.0.0.1:${port}`)
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const password = process.env.UI_PASSWORD ?? '';
  if (!local && !password) {
    throw new Error(`HOST=${host} exposes the UI beyond this machine; set UI_PASSWORD in .env.`);
  }
  const rawPrivate = process.env.ALLOW_PRIVATE_URLS;
  return {
    port,
    host,
    allowedOrigins: origins,
    password,
    maxSteps: intEnv('UI_MAX_STEPS', 30),
    allowPrivateUrls: rawPrivate ? rawPrivate === 'true' : local,
    deployPollMs: intEnv('DEPLOY_POLL_MS', 60_000),
  };
}
