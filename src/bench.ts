// Benchmark runner: grades Probei against the zoo ground truth (npm run bench).
// Runs each ground-truth scenario headless, then scores the reports:
// bug scenarios must end in "bug", clean ones in "passed".
//
// Harness-only: zoo/bugs.json is read from disk to SCORE finished runs. It never
// goes into model prompts, and the zoo server returns 404 for it, so the agent
// under test cannot see the answers.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runScenario, type RunResult } from './agent.js';
import { getAgentConfig } from './config.js';
import { httpUrl } from './projects.js';
import { writeReport } from './report.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const TRUTH = join(root, 'zoo', 'bugs.json');

export type Expectation = 'bug' | 'pass';

export interface BenchCase {
  id: string;
  url: string;
  scenario: string;
  expect: Expectation;
}

export interface CaseScore {
  id: string;
  expect: Expectation;
  status: RunResult['status'];
  /** Bug expected and found, or clean and passed. Anything else (stuck, error, …) is a miss. */
  ok: boolean;
  steps: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  bugTitle: string | null;
}

export interface BenchSummary {
  cases: number;
  bugsFound: number;
  bugsTotal: number;
  cleanPassed: number;
  cleanTotal: number;
  /** Clean scenarios wrongly reported as bugs. */
  falseAlarms: number;
  steps: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
}

function textOf(item: Record<string, unknown>): string {
  for (const key of ['scenario', 'text', 'steps']) {
    if (typeof item[key] === 'string' && (item[key] as string).trim()) return (item[key] as string).trim();
  }
  return '';
}

/** bug/pass from an explicit field; null when the item carries no expectation. */
function expectOf(item: Record<string, unknown>): Expectation | null {
  for (const key of ['expect', 'expected', 'expects']) {
    const v = item[key];
    if (typeof v !== 'string') continue;
    const s = v.trim().toLowerCase();
    if (s === 'bug' || s === 'fail' || s === 'error') return 'bug';
    if (s === 'pass' || s === 'passed' || s === 'clean' || s === 'ok') return 'pass';
  }
  return null;
}

function toCase(
  item: unknown,
  fallbackId: string,
  fallbackExpect: Expectation | null,
  defaultUrl: string,
): BenchCase | null {
  // A bare string is a whole clean scenario (see clean_scenarios below).
  if (typeof item === 'string') {
    const scenario = item.trim();
    if (!scenario || fallbackExpect !== 'pass') return null;
    return { id: fallbackId, url: defaultUrl, scenario, expect: 'pass' };
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  const scenario = textOf(rec);
  if (!scenario) return null;
  const expect = expectOf(rec) ?? fallbackExpect;
  if (!expect) return null;
  const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim().slice(0, 60) : fallbackId;
  return { id, url: httpUrl(rec.url) ?? defaultUrl, scenario, expect };
}

/**
 * Parses the ground-truth file tolerantly. Accepted shapes:
 * - { apps: { <name>: { url, bugs: [...], clean_scenarios: [...] } } } (the zoo file),
 * - { scenarios: [...] } (each item carries its own expectation),
 * - { bugs: [...], clean: [...] } (expectation from the array),
 * - [...] (bare array with per-item expectations).
 * Drops blank or expectation-less entries instead of throwing.
 */
export function parseGroundTruth(raw: unknown, defaultUrl: string): BenchCase[] {
  const out: BenchCase[] = [];
  const push = (items: unknown, fallbackExpect: Expectation | null, prefix: string, url: string) => {
    if (!Array.isArray(items)) return;
    items.forEach((item, i) => {
      const c = toCase(item, `${prefix}${i + 1}`, fallbackExpect, url);
      if (c) out.push(c);
    });
  };
  if (Array.isArray(raw)) {
    push(raw, null, 'case-', defaultUrl);
    return out;
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    push(rec.scenarios, null, 'case-', defaultUrl);
    push(rec.bugs, 'bug', 'bug-', defaultUrl);
    push(rec.clean, 'pass', 'clean-', defaultUrl);
    const apps = rec.apps;
    if (apps && typeof apps === 'object' && !Array.isArray(apps)) {
      for (const [name, app] of Object.entries(apps as Record<string, unknown>)) {
        if (!app || typeof app !== 'object' || Array.isArray(app)) continue;
        const a = app as Record<string, unknown>;
        const url = httpUrl(a.url) ?? defaultUrl;
        push(a.bugs, 'bug', `${name}-bug-`, url);
        push(a.clean_scenarios ?? a.clean, 'pass', `${name}-clean-`, url);
      }
    }
  }
  return out;
}

export function scoreCase(c: BenchCase, r: RunResult): CaseScore {
  const ok = c.expect === 'bug' ? r.status === 'bug' : r.status === 'passed';
  return {
    id: c.id,
    expect: c.expect,
    status: r.status,
    ok,
    steps: r.steps.length,
    durationMs: r.durationMs,
    promptTokens: r.usage.promptTokens,
    completionTokens: r.usage.completionTokens,
    bugTitle: r.bug?.title ?? null,
  };
}

export function summarize(scores: CaseScore[]): BenchSummary {
  const s: BenchSummary = {
    cases: scores.length,
    bugsFound: 0,
    bugsTotal: 0,
    cleanPassed: 0,
    cleanTotal: 0,
    falseAlarms: 0,
    steps: 0,
    durationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
  for (const c of scores) {
    if (c.expect === 'bug') {
      s.bugsTotal++;
      if (c.ok) s.bugsFound++;
    } else {
      s.cleanTotal++;
      if (c.ok) s.cleanPassed++;
      if (c.status === 'bug') s.falseAlarms++;
    }
    s.steps += c.steps;
    s.durationMs += c.durationMs;
    s.promptTokens += c.promptTokens;
    s.completionTokens += c.completionTokens;
  }
  return s;
}

function usd(prompt: number, completion: number, priceIn: number, priceOut: number): string {
  return `$${((prompt * priceIn + completion * priceOut) / 1e6).toFixed(3)}`;
}

function pad(v: string | number, n: number): string {
  return String(v).padEnd(n).slice(0, n);
}

function printTable(scores: CaseScore[], summary: BenchSummary, priceIn: number, priceOut: number): void {
  console.log(`\n${pad('case', 28)} ${pad('expect', 6)} ${pad('got', 10)} ${pad('ok', 3)} ${pad('steps', 5)} ${pad('time', 7)} ${pad('tokens', 13)} bug`);
  for (const c of scores) {
    console.log(
      `${pad(c.id, 28)} ${pad(c.expect, 6)} ${pad(c.status, 10)} ${pad(c.ok ? 'yes' : 'NO', 3)} ${pad(c.steps, 5)} ${pad(`${Math.round(c.durationMs / 1000)}s`, 7)} ${pad(`${c.promptTokens}/${c.completionTokens}`, 13)} ${c.bugTitle ?? ''}`,
    );
  }
  console.log(
    `\nBugs found: ${summary.bugsFound}/${summary.bugsTotal} · clean passed: ${summary.cleanPassed}/${summary.cleanTotal} · ` +
      `false alarms: ${summary.falseAlarms}\n` +
      `Totals: ${summary.steps} steps, ${Math.round(summary.durationMs / 1000)}s, ` +
      `${summary.promptTokens} in / ${summary.completionTokens} out tokens, ` +
      `≈${usd(summary.promptTokens, summary.completionTokens, priceIn, priceOut)} ` +
      `at $${priceIn}/$${priceOut} per 1M in/out.`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'max-steps': { type: 'string' },
      limit: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      'url-from': { type: 'string' },
      'url-to': { type: 'string' },
      'price-in': { type: 'string' },
      'price-out': { type: 'string' },
    },
  });

  const num = (v: string | undefined, fallback: number): number => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Expected a positive number, got "${v}"`);
    return n;
  };

  const agentConfig = getAgentConfig();
  const maxSteps = num(values['max-steps'], agentConfig.maxSteps);
  const limit = values.limit === undefined ? Infinity : Math.floor(num(values.limit, Infinity));
  const priceIn = num(values['price-in'], 1.25);
  const priceOut = num(values['price-out'], 4.25);
  /** Rewrite applied to start URLs and scenario texts, e.g. shop/ → shop2/ for the redesign test. */
  const remap = (s: string): string =>
    values['url-from'] && values['url-to'] ? s.split(values['url-from']).join(values['url-to']) : s;

  let cases: BenchCase[];
  try {
    cases = parseGroundTruth(JSON.parse(await readFile(TRUTH, 'utf8')), 'http://localhost:5173/shop/');
  } catch (err) {
    console.error(`Could not read ${TRUTH}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (values.limit !== undefined) cases = cases.slice(0, limit);
  if (!cases.length) {
    console.error('The ground-truth file holds no runnable scenarios.');
    process.exit(1);
  }

  const found = cases.filter((c) => c.expect === 'bug').length;
  console.log(`${cases.length} case(s): ${found} bug, ${cases.length - found} clean.`);
  if (values.verbose) {
    for (const c of cases) console.log(`- ${c.id} [${c.expect}] ${remap(c.url)}`);
  }
  if (values['dry-run']) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scores: CaseScore[] = [];
  for (const [i, c] of cases.entries()) {
    const runDir = join(root, 'runs', `bench-${stamp}-${String(i + 1).padStart(2, '0')}`);
    await mkdir(runDir, { recursive: true });
    console.log(`\n[${i + 1}/${cases.length}] ${c.id} (expect ${c.expect}) …`);
    const result = await runScenario({ url: remap(c.url), scenario: remap(c.scenario), runDir, maxSteps, headless: true });
    await writeReport(runDir, result);
    const score = scoreCase(c, result);
    scores.push(score);
    console.log(`→ ${score.status} in ${score.steps} step(s)${score.bugTitle ? `: ${score.bugTitle}` : ''} ${score.ok ? '' : '(MISS)'}`);
  }

  const summary = summarize(scores);
  printTable(scores, summary, priceIn, priceOut);
  const benchDir = join(root, 'bench');
  await mkdir(benchDir, { recursive: true });
  const outFile = join(benchDir, `${stamp}.json`);
  await writeFile(outFile, JSON.stringify({ at: new Date().toISOString(), maxSteps, summary, scores }, null, 2));
  console.log(`\nSaved ${outFile}`);
}

// Tests import the pure helpers above; the CLI runs only as the entry point.
if ((process.argv[1] ?? '').endsWith('bench.ts')) await main();
