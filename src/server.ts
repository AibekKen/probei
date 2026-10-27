// Web UI server for Probei: npm run ui  →  http://localhost:5174/
// One page to start a run, stream its steps live over SSE and read past reports.
import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, type RunResult, type Step } from './agent.js';
import { getAgentConfig, getUiPort } from './config.js';
import { llmInfo } from './llm.js';
import { writeReport } from './report.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const webDir = join(root, 'web');
const runsDir = join(root, 'runs');

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const RUN_FILE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};
const RUN_ID = /^[\w-]+$/;

interface ActiveRun {
  id: string;
  url: string;
  scenario: string;
  startedAt: string;
  steps: Step[];
  clients: Set<ServerResponse>;
  finished: boolean;
}

interface RunSummary {
  id: string;
  status: RunResult['status'] | 'running';
  url: string;
  scenario: string;
  startedAt: string;
  steps: number;
  bugTitle: string | null;
}

let active: ActiveRun | null = null;

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
}

function sendEvent(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(run: ActiveRun, payload: unknown): void {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...run.clients]) {
    try {
      client.write(line);
    } catch {
      run.clients.delete(client);
    }
  }
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Serves one file only if it stays inside its base dir and has an allowed extension. */
async function sendFile(
  res: ServerResponse,
  baseDir: string,
  name: string,
  types: Record<string, string>,
): Promise<void> {
  if (name.includes('bugs.json') || basename(name).startsWith('.')) {
    res.writeHead(404).end('Not found');
    return;
  }
  const file = normalize(join(baseDir, name));
  if (!file.startsWith(baseDir + '/')) {
    res.writeHead(404).end('Not found');
    return;
  }
  const type = types[extname(file)];
  if (!type) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': type }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

async function handleStartRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (active && !active.finished) {
    json(res, 409, { error: `Run ${active.id} is still active; one run at a time.` });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  const scenario = typeof b.scenario === 'string' ? b.scenario.trim() : '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
  } catch {
    json(res, 400, { error: 'url must be an http(s) URL' });
    return;
  }
  if (!scenario || scenario.length > 8000) {
    json(res, 400, { error: 'scenario must be 1–8000 characters' });
    return;
  }
  const agentConfig = getAgentConfig();
  const maxSteps = b.maxSteps === undefined ? agentConfig.maxSteps : b.maxSteps;
  if (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) {
    json(res, 400, { error: 'maxSteps must be an integer from 1 to 200' });
    return;
  }
  try {
    llmInfo(); // fail fast when the provider settings are missing
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
    return;
  }

  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(runsDir, id);
  await mkdir(runDir, { recursive: true });
  const run: ActiveRun = {
    id,
    url,
    scenario,
    startedAt: new Date().toISOString(),
    steps: [],
    clients: new Set(),
    finished: false,
  };
  active = run;
  json(res, 202, { id });

  void (async () => {
    try {
      const result = await runScenario({
        url,
        scenario,
        runDir,
        maxSteps,
        headless: true, // headed stays CLI-only; the server never opens a visible browser
        onStep: (s) => {
          run.steps.push(s);
          broadcast(run, { type: 'step', step: s });
        },
      });
      await writeReport(runDir, result);
      broadcast(run, {
        type: 'done',
        status: result.status,
        summary: result.summary ?? null,
        bug: result.bug ?? null,
        error: result.error ?? null,
        video: result.video ? basename(result.video) : null,
      });
    } catch (err) {
      broadcast(run, { type: 'done', status: 'error', error: (err as Error).message });
    } finally {
      run.finished = true;
      for (const client of run.clients) client.end();
      run.clients.clear();
      if (active === run) active = null;
    }
  })();
}

async function listRuns(): Promise<RunSummary[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const id of entries) {
    if (!RUN_ID.test(id)) continue;
    if (active && !active.finished && active.id === id) {
      out.push({
        id,
        status: 'running',
        url: active.url,
        scenario: active.scenario,
        startedAt: active.startedAt,
        steps: active.steps.length,
        bugTitle: null,
      });
      continue;
    }
    try {
      const raw = await readFile(join(runsDir, id, 'report.json'), 'utf8');
      const r = JSON.parse(raw) as RunResult;
      out.push({
        id,
        status: r.status,
        url: r.url,
        scenario: r.scenario,
        startedAt: r.startedAt,
        steps: r.steps.length,
        bugTitle: r.bug?.title ?? null,
      });
    } catch {
      // A directory without a report is not a finished run; skip it.
    }
  }
  return out.sort((a, z) => (a.id < z.id ? 1 : -1));
}

async function handleEvents(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!RUN_ID.test(id)) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const run = active && !active.finished && active.id === id ? active : null;
  if (run) {
    // Live run: replay buffered steps, then keep the stream open for new ones.
    for (const step of run.steps) sendEvent(res, { type: 'step', step });
    run.clients.add(res);
    req.on('close', () => run.clients.delete(res));
    return;
  }
  try {
    const raw = await readFile(join(runsDir, id, 'report.json'), 'utf8');
    const result = JSON.parse(raw) as RunResult;
    for (const step of result.steps) sendEvent(res, { type: 'step', step });
    sendEvent(res, {
      type: 'done',
      status: result.status,
      summary: result.summary ?? null,
      bug: result.bug ?? null,
      error: result.error ?? null,
      video: result.video ? basename(result.video) : null,
    });
  } catch {
    sendEvent(res, { type: 'done', status: 'error', error: `No report for run ${id}` });
  }
  res.end();
}

async function handleRunFile(res: ServerResponse, id: string, name: string): Promise<void> {
  if (!RUN_ID.test(id) || name !== basename(name)) {
    res.writeHead(404).end('Not found');
    return;
  }
  await sendFile(res, join(runsDir, id), name, RUN_FILE_TYPES);
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const method = req.method ?? 'GET';
    if (pathname.includes('bugs.json')) {
      res.writeHead(404).end('Not found');
      return;
    }

    if (method === 'GET' && pathname === '/') {
      await sendFile(res, webDir, 'index.html', STATIC_TYPES);
      return;
    }
    if (method === 'POST' && pathname === '/api/runs') {
      await handleStartRun(req, res);
      return;
    }
    if (method === 'GET' && pathname === '/api/runs') {
      json(res, 200, await listRuns());
      return;
    }
    const events = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (method === 'GET' && events) {
      await handleEvents(req, res, events[1]);
      return;
    }
    const report = pathname.match(/^\/api\/runs\/([^/]+)\/report$/);
    if (method === 'GET' && report) {
      if (!RUN_ID.test(report[1])) {
        res.writeHead(404).end('Not found');
        return;
      }
      await sendFile(res, join(runsDir, report[1]), 'report.json', RUN_FILE_TYPES);
      return;
    }
    const file = pathname.match(/^\/api\/runs\/([^/]+)\/files\/(.+)$/);
    if (method === 'GET' && file) {
      await handleRunFile(res, file[1], file[2]);
      return;
    }
    if (method === 'GET' && !pathname.startsWith('/api/')) {
      await sendFile(res, webDir, pathname.slice(1) || 'index.html', STATIC_TYPES);
      return;
    }
    res.writeHead(404).end('Not found');
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    else res.end();
  }
}

await mkdir(runsDir, { recursive: true });
const port = getUiPort();
createServer((req, res) => void onRequest(req, res)).listen(port, () => {
  console.log(`Probei UI: http://localhost:${port}/`);
});
