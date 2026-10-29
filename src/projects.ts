// Projects for the web UI: a project is an app URL with its saved scenarios.
// Stored as one JSON file in data/ (git-ignored); runs link back via runs/<id>/meta.json.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Scenario {
  id: string;
  title: string;
  text: string;
  /** Start URL for the run; defaults to the project URL. */
  url: string;
  source: 'manual' | 'auto';
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  scenarios: Scenario[];
  lastReview?: { at: string; pages: number; added: number };
  /** When true, the server watches the app URL and records each new deploy. */
  notifyOnDeploy: boolean;
  /** When true, a detected deploy also queues all scenarios. Needs no other flag. */
  autoRunOnDeploy: boolean;
  /** Last seen deploy fingerprint (ETag / Last-Modified / body hash); null until first check. */
  deployFingerprint: string | null;
  lastDeployCheckAt?: string;
  lastDeployAt?: string;
}

export interface Store {
  projects: Project[];
}

export const MAX_PROJECTS = 100;
export const MAX_SCENARIOS = 200;

export function makeId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function firstLine(text: string, max = 60): string {
  const line = text.trim().split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function defaultName(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return path ? `${u.host}${path}` : u.host;
  } catch {
    return url;
  }
}

/** Parses the stored file tolerantly: drops broken entries, never throws. */
export function parseStore(raw: unknown): Store {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Store).projects)) return { projects: [] };
  const projects: Project[] = [];
  for (const p of (raw as Store).projects) {
    if (!p || typeof p !== 'object') continue;
    const url = httpUrl(p.url);
    if (!url || typeof p.id !== 'string') continue;
    const scenarios: Scenario[] = [];
    for (const s of Array.isArray(p.scenarios) ? p.scenarios : []) {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string') continue;
      if (typeof s.text !== 'string' || !s.text.trim()) continue;
      scenarios.push({
        id: s.id,
        title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : firstLine(s.text),
        text: s.text.trim(),
        url: httpUrl(s.url) ?? url,
        source: s.source === 'auto' ? 'auto' : 'manual',
        createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date(0).toISOString(),
      });
    }
    projects.push({
      id: p.id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : defaultName(url),
      url,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date(0).toISOString(),
      scenarios,
      ...(p.lastReview && typeof p.lastReview === 'object' ? { lastReview: p.lastReview } : {}),
      notifyOnDeploy: p.notifyOnDeploy === true,
      autoRunOnDeploy: p.autoRunOnDeploy === true,
      deployFingerprint: typeof p.deployFingerprint === 'string' && p.deployFingerprint ? p.deployFingerprint : null,
      ...(typeof p.lastDeployCheckAt === 'string' ? { lastDeployCheckAt: p.lastDeployCheckAt } : {}),
      ...(typeof p.lastDeployAt === 'string' ? { lastDeployAt: p.lastDeployAt } : {}),
    });
  }
  return { projects };
}

export function createProject(input: { name?: string; url: string }): Project {
  return {
    id: makeId('p'),
    name: input.name?.trim() || defaultName(input.url),
    url: input.url,
    createdAt: new Date().toISOString(),
    scenarios: [],
    notifyOnDeploy: false,
    autoRunOnDeploy: false,
    deployFingerprint: null,
  };
}

/**
 * Appends scenarios to a project, skipping blank ones and texts the project
 * already has. Returns the ones actually added.
 */
export function addScenarios(
  project: Project,
  items: { title?: string; text: string; url?: string }[],
  source: Scenario['source'],
): Scenario[] {
  const seen = new Set(project.scenarios.map((s) => normalizeText(s.text)));
  const added: Scenario[] = [];
  for (const item of items) {
    const text = item.text.trim();
    const key = normalizeText(text);
    if (!text || seen.has(key) || project.scenarios.length >= MAX_SCENARIOS) continue;
    seen.add(key);
    const scenario: Scenario = {
      id: makeId('s'),
      title: item.title?.trim() || firstLine(text),
      text,
      url: httpUrl(item.url) ?? project.url,
      source,
      createdAt: new Date().toISOString(),
    };
    project.scenarios.push(scenario);
    added.push(scenario);
  }
  return added;
}

/** File-backed store; writes are serialized and atomic (temp file + rename). */
export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<Store> {
    try {
      return parseStore(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      return { projects: [] };
    }
  }

  /** Runs fn on a fresh copy of the store and saves it, one update at a time. */
  update<T>(fn: (store: Store) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const store = await this.read();
      const result = fn(store);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(store, null, 2));
      await rename(tmp, this.file);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
