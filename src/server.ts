// Web UI server for Probei: npm run ui  →  http://localhost:5174/
// One page to start a run, stream its steps live over SSE and read past reports.
import 'dotenv/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, type RunResult, type Step } from './agent.js';
import { getAgentConfig, getUiConfig } from './config.js';
import { llmInfo } from './llm.js';
import { isPublicHost } from './netguard.js';
import {
  addScenarios,
  createProject,
  httpUrl,
  MAX_PROJECTS,
  ProjectStore,
  type Project,
  type Store,
} from './projects.js';
import { writeReport } from './report.js';
import { reviewApp, suggestScenarios } from './suggest.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const webDir = join(root, 'web');
const runsDir = join(root, 'runs');
const dataDir = join(root, 'data');
const REVIEW_PAGES = 8;

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
const ui = getUiConfig();

/** Which saved scenario a run belongs to, kept in runs/<id>/meta.json. */
interface RunLink {
  projectId: string | null;
  scenarioId: string | null;
}

interface ActiveRun extends RunLink {
  id: string;
  url: string;
  scenario: string;
  startedAt: string;
  steps: Step[];
  clients: Set<ServerResponse>;
  finished: boolean;
}

/** A run waiting its turn; the server runs one at a time, in order. */
interface QueuedRun extends RunLink {
  id: string;
  url: string;
  scenario: string;
  maxSteps: number;
  queuedAt: string;
  /** Event streams opened before the run started; they carry over to the live run. */
  clients: Set<ServerResponse>;
}

interface RunSummary extends RunLink {
  id: string;
  status: RunResult['status'] | 'running' | 'queued';
  url: string;
  scenario: string;
  startedAt: string;
  steps: number;
  bugTitle: string | null;
}

let active: ActiveRun | null = null;
const queue: QueuedRun[] = [];
let lastRunId = '';
let reviewing = false;
const projects = new ProjectStore(join(dataDir, 'projects.json'));

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** HTTP Basic auth with any user name and UI_PASSWORD. Open when no password is set. */
function authorized(req: IncomingMessage): boolean {
  if (!ui.password) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(digest(password), digest(ui.password));
}

/** Blocks other web pages from starting runs through the visitor's browser. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined || ui.allowedOrigins.includes(origin);
}

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

/** Validated run options from a request body, or null after sending the error. */
async function readRunOptions(res: ServerResponse, b: Record<string, unknown>): Promise<{ maxSteps: number } | null> {
  const agentConfig = getAgentConfig();
  const maxSteps = b.maxSteps === undefined ? Math.min(agentConfig.maxSteps, ui.maxSteps) : b.maxSteps;
  if (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > ui.maxSteps) {
    json(res, 400, { error: `maxSteps must be an integer from 1 to ${ui.maxSteps}` });
    return null;
  }
  try {
    llmInfo(); // fail fast when the provider settings are missing
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
    return null;
  }
  return { maxSteps };
}

/** Time-based run id, unique even for several runs queued in the same millisecond. */
function newRunId(): string {
  let id = new Date().toISOString().replace(/[:.]/g, '-');
  for (let n = 2; id <= lastRunId; n++) id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${n}`;
  lastRunId = id;
  return id;
}

function enqueue(item: Omit<QueuedRun, 'id' | 'queuedAt' | 'clients'>): string {
  const id = newRunId();
  queue.push({ ...item, id, queuedAt: new Date().toISOString(), clients: new Set() });
  void startNext();
  return id;
}

/** Is this scenario already waiting or running? Run-all skips those. */
function scenarioBusy(scenarioId: string): boolean {
  return (active !== null && !active.finished && active.scenarioId === scenarioId) || queue.some((q) => q.scenarioId === scenarioId);
}

async function handleStartRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readJsonRequest(req, res);
  if (!b) return;
  const url = await allowedUrl(res, b.url);
  if (!url) return;
  const scenario = typeof b.scenario === 'string' ? b.scenario.trim() : '';
  if (!scenario || scenario.length > 8000) {
    json(res, 400, { error: 'scenario must be 1–8000 characters' });
    return;
  }
  const opts = await readRunOptions(res, b);
  if (!opts) return;
  const link: RunLink = {
    projectId: typeof b.projectId === 'string' && RUN_ID.test(b.projectId) ? b.projectId : null,
    scenarioId: typeof b.scenarioId === 'string' && RUN_ID.test(b.scenarioId) ? b.scenarioId : null,
  };
  if (link.scenarioId && scenarioBusy(link.scenarioId)) {
    json(res, 409, { error: 'This scenario is already queued or running.' });
    return;
  }
  const id = enqueue({ ...link, url, scenario, maxSteps: opts.maxSteps });
  json(res, 202, { id, queued: queue.some((q) => q.id === id) });
}

/** Queues every scenario of a project that is not already waiting or running. */
async function handleRunAll(req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> {
  const b = await readJsonRequest(req, res);
  if (!b) return;
  const project = (await projects.read()).projects.find((p) => p.id === projectId);
  if (!project) {
    json(res, 404, { error: 'Project not found' });
    return;
  }
  const opts = await readRunOptions(res, b);
  if (!opts) return;
  const ids: string[] = [];
  for (const s of project.scenarios) {
    if (scenarioBusy(s.id)) continue;
    if (!ui.allowPrivateUrls && !(await isPublicHost(new URL(s.url).hostname))) continue;
    ids.push(enqueue({ projectId, scenarioId: s.id, url: s.url, scenario: s.text, maxSteps: opts.maxSteps }));
  }
  json(res, 202, { ids });
}

/** Drops waiting runs (all, or one project's); the running one finishes. */
async function handleClearQueue(req: IncomingMessage, res: ServerResponse, projectId?: string): Promise<void> {
  if (!(await readJsonRequest(req, res, false))) return;
  let removed = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (projectId && queue[i].projectId !== projectId) continue;
    const [q] = queue.splice(i, 1);
    for (const client of q.clients) {
      sendEvent(client, { type: 'done', status: 'error', error: 'Removed from the queue' });
      client.end();
    }
    removed++;
  }
  json(res, 200, { removed });
}

/** Starts the next queued run when nothing is running. */
async function startNext(): Promise<void> {
  if ((active && !active.finished) || !queue.length) return;
  const next = queue.shift()!;
  const runDir = join(runsDir, next.id);
  const run: ActiveRun = {
    projectId: next.projectId,
    scenarioId: next.scenarioId,
    id: next.id,
    url: next.url,
    scenario: next.scenario,
    startedAt: new Date().toISOString(),
    steps: [],
    clients: next.clients,
    finished: false,
  };
  active = run;
  broadcast(run, { type: 'started' });

  let done: Record<string, unknown> = { type: 'done', status: 'error', error: 'Run ended unexpectedly' };
  try {
    await mkdir(runDir, { recursive: true });
    if (next.projectId) {
      await writeFile(join(runDir, 'meta.json'), JSON.stringify({ projectId: next.projectId, scenarioId: next.scenarioId }));
    }
    const result = await runScenario({
      url: next.url,
      scenario: next.scenario,
      runDir,
      maxSteps: next.maxSteps,
      headless: true, // headed stays CLI-only; the server never opens a visible browser
      blockPrivate: !ui.allowPrivateUrls,
      onStep: (s) => {
        run.steps.push(s);
        broadcast(run, { type: 'step', step: s });
      },
    });
    await writeReport(runDir, result);
    done = {
      type: 'done',
      status: result.status,
      summary: result.summary ?? null,
      bug: result.bug ?? null,
      error: result.error ?? null,
      video: result.video ? basename(result.video) : null,
    };
  } catch (err) {
    done = { type: 'done', status: 'error', error: (err as Error).message };
  } finally {
    // Mark finished before the last event, so a client connecting now reads the saved report instead.
    run.finished = true;
    broadcast(run, done);
    for (const client of run.clients) client.end();
    run.clients.clear();
    if (active === run) active = null;
    void startNext();
  }
}

/** Origin check plus, for requests with a body, a parsed JSON object. Sends the error itself and returns null. */
async function readJsonRequest(
  req: IncomingMessage,
  res: ServerResponse,
  hasBody = true,
): Promise<Record<string, unknown> | null> {
  if (!originAllowed(req)) {
    json(res, 403, { error: 'Origin not allowed' });
    return null;
  }
  if (!hasBody) return {};
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'Content-Type must be application/json' });
    return null;
  }
  try {
    const body = JSON.parse(await readBody(req)) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  json(res, 400, { error: 'Invalid JSON body' });
  return null;
}

/** An http(s) URL this server may open, or null after sending the error. */
async function allowedUrl(res: ServerResponse, value: unknown, field = 'url'): Promise<string | null> {
  const url = httpUrl(value);
  if (!url) {
    json(res, 400, { error: `${field} must be an http(s) URL` });
    return null;
  }
  if (!ui.allowPrivateUrls && !(await isPublicHost(new URL(url).hostname))) {
    json(res, 400, { error: `${field} must point to a public address on this server` });
    return null;
  }
  return url;
}

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, max) : undefined;
}

class HttpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function findProject(store: Store, id: string): Project {
  const project = store.projects.find((p) => p.id === id);
  if (!project) throw new HttpError(404, 'Project not found');
  return project;
}

/** Runs a store update and replies with its result; an HttpError thrown inside becomes the reply. */
async function storeUpdate<T>(res: ServerResponse, code: number, fn: (store: Store) => T): Promise<void> {
  try {
    json(res, code, await projects.update(fn));
  } catch (err) {
    if (err instanceof HttpError) json(res, err.code, { error: err.message });
    else throw err;
  }
}

async function handleProjects(req: IncomingMessage, res: ServerResponse, method: string, parts: string[]): Promise<void> {
  const [projectId, sub, scenarioId] = parts;
  if (method === 'GET' && !projectId) {
    json(res, 200, await projects.read());
    return;
  }
  const hasBody = method === 'POST' || method === 'PATCH';
  if (!['POST', 'PATCH', 'DELETE'].includes(method)) {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  const b = await readJsonRequest(req, res, hasBody && sub !== 'review');
  if (!b) return;

  if (!projectId && method === 'POST') {
    const url = await allowedUrl(res, b.url);
    if (!url) return;
    const name = optionalString(b.name, 120);
    await storeUpdate(res, 201, (store) => {
      if (store.projects.length >= MAX_PROJECTS) throw new HttpError(400, `At most ${MAX_PROJECTS} projects`);
      const project = createProject({ name, url });
      store.projects.push(project);
      return project;
    });
    return;
  }
  if (projectId && !sub) {
    if (method === 'DELETE') {
      await storeUpdate(res, 200, (store) => {
        findProject(store, projectId);
        store.projects = store.projects.filter((p) => p.id !== projectId);
        return { ok: true };
      });
      return;
    }
    if (method === 'PATCH') {
      const url = b.url === undefined ? undefined : await allowedUrl(res, b.url);
      if (url === null) return;
      const name = optionalString(b.name, 120);
      await storeUpdate(res, 200, (store) => {
        const project = findProject(store, projectId);
        if (name) project.name = name;
        if (url) project.url = url;
        return project;
      });
      return;
    }
  }
  if (projectId && sub === 'scenarios' && !scenarioId && method === 'POST') {
    const text = optionalString(b.text, 8000);
    if (!text) {
      json(res, 400, { error: 'text must be 1–8000 characters' });
      return;
    }
    const url = b.url === undefined || b.url === '' ? undefined : await allowedUrl(res, b.url);
    if (url === null) return;
    const title = optionalString(b.title, 120);
    await storeUpdate(res, 201, (store) => {
      const [added] = addScenarios(findProject(store, projectId), [{ title, text, url }], 'manual');
      if (!added) throw new HttpError(409, 'This project already has that scenario');
      return added;
    });
    return;
  }
  if (projectId && sub === 'scenarios' && scenarioId) {
    if (method === 'DELETE') {
      await storeUpdate(res, 200, (store) => {
        const project = findProject(store, projectId);
        project.scenarios = project.scenarios.filter((s) => s.id !== scenarioId);
        return { ok: true };
      });
      return;
    }
    if (method === 'PATCH') {
      const text = optionalString(b.text, 8000);
      const title = optionalString(b.title, 120);
      const url = b.url === undefined || b.url === '' ? undefined : await allowedUrl(res, b.url);
      if (url === null) return;
      await storeUpdate(res, 200, (store) => {
        const scenario = findProject(store, projectId).scenarios.find((s) => s.id === scenarioId);
        if (!scenario) throw new HttpError(404, 'Scenario not found');
        if (text) scenario.text = text;
        if (title) scenario.title = title;
        if (url) scenario.url = url;
        return scenario;
      });
      return;
    }
  }
  if (projectId && sub === 'review' && method === 'POST') {
    await handleReview(res, projectId);
    return;
  }
  res.writeHead(404).end('Not found');
}

/** Auto-review: crawl the project's app, draft scenarios with the model, save the new ones. */
async function handleReview(res: ServerResponse, projectId: string): Promise<void> {
  const project = (await projects.read()).projects.find((p) => p.id === projectId);
  if (!project) {
    json(res, 404, { error: 'Project not found' });
    return;
  }
  if (reviewing) {
    json(res, 409, { error: 'An auto-review is already running; one at a time.' });
    return;
  }
  if (!(await allowedUrl(res, project.url))) return;
  try {
    llmInfo(); // fail fast when the provider settings are missing
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
    return;
  }

  reviewing = true;
  try {
    const { review, homeScreenshot } = await reviewApp({
      url: project.url,
      maxPages: REVIEW_PAGES,
      headless: true, // the server never opens a visible browser
      blockPrivate: !ui.allowPrivateUrls,
    });
    const { scenarios } = await suggestScenarios(review, homeScreenshot);
    await storeUpdate(res, 200, (store) => {
      const p = findProject(store, projectId);
      const added = addScenarios(
        p,
        scenarios.map((s) => ({ title: s.title, text: s.scenario, url: s.url })),
        'auto',
      );
      p.lastReview = { at: new Date().toISOString(), pages: review.pages.length, added: added.length };
      return { added, pagesReviewed: review.pages.length, drafted: scenarios.length };
    });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  } finally {
    reviewing = false;
  }
}

async function readLink(id: string): Promise<RunLink> {
  try {
    const raw = JSON.parse(await readFile(join(runsDir, id, 'meta.json'), 'utf8')) as Partial<RunLink>;
    return {
      projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
      scenarioId: typeof raw.scenarioId === 'string' ? raw.scenarioId : null,
    };
  } catch {
    return { projectId: null, scenarioId: null };
  }
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
        projectId: active.projectId,
        scenarioId: active.scenarioId,
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
        ...(await readLink(id)),
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
  for (const q of queue) {
    out.push({
      id: q.id,
      projectId: q.projectId,
      scenarioId: q.scenarioId,
      status: 'queued',
      url: q.url,
      scenario: q.scenario,
      startedAt: q.queuedAt,
      steps: 0,
      bugTitle: null,
    });
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
  const waiting = queue.find((q) => q.id === id);
  if (waiting) {
    // Queued: hold the stream open; it moves to the live run when the run starts.
    sendEvent(res, { type: 'queued', position: queue.indexOf(waiting) + 1 });
    waiting.clients.add(res);
    req.on('close', () => waiting.clients.delete(res));
    return;
  }
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
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Probei"' }).end('Authentication required');
      return;
    }
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
    if (method === 'DELETE' && pathname === '/api/queue') {
      await handleClearQueue(req, res);
      return;
    }
    const runAll = pathname.match(/^\/api\/projects\/([\w-]+)\/run-all$/);
    if (method === 'POST' && runAll) {
      await handleRunAll(req, res, runAll[1]);
      return;
    }
    const projectQueue = pathname.match(/^\/api\/projects\/([\w-]+)\/queue$/);
    if (method === 'DELETE' && projectQueue) {
      await handleClearQueue(req, res, projectQueue[1]);
      return;
    }
    const project = pathname.match(/^\/api\/projects(?:\/([\w-]+))?(?:\/(scenarios|review))?(?:\/([\w-]+))?\/?$/);
    if (project) {
      await handleProjects(req, res, method, project.slice(1).filter(Boolean));
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
createServer((req, res) => void onRequest(req, res)).listen(ui.port, ui.host, () => {
  const where = ui.host === '0.0.0.0' || ui.host === '::' ? `all interfaces, port ${ui.port}` : `http://${ui.host}:${ui.port}/`;
  console.log(`Probei UI: ${where}${ui.password ? ' (password required)' : ''}`);
  if (!ui.allowPrivateUrls) console.log('Runs may only open public addresses (ALLOW_PRIVATE_URLS=false).');
});
