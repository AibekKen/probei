import { join } from 'node:path';
import { BrowserSession, VIEWPORT } from './browser.js';
import { askJSON, llmInfo, type Usage } from './llm.js';

export type Severity = 'critical' | 'major' | 'minor';

export type Action =
  | { type: 'click'; x: number; y: number; target?: string }
  | { type: 'type'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; dy: number }
  | { type: 'wait'; ms: number }
  | { type: 'done'; summary: string }
  | { type: 'bug'; title: string; severity: Severity; expected: string; actual: string; summary: string };

export interface Step {
  n: number;
  thought: string;
  action: Action | null;
  note?: string;
  screenshot: string;
  errors: string[];
}

export type RunStatus = 'passed' | 'bug' | 'stuck' | 'max_steps' | 'error';

export interface RunResult {
  status: RunStatus;
  url: string;
  scenario: string;
  provider: string;
  model: string;
  steps: Step[];
  bug?: Extract<Action, { type: 'bug' }>;
  summary?: string;
  error?: string;
  usage: Usage;
  startedAt: string;
  durationMs: number;
  video?: string;
}

const SYSTEM_PROMPT = `You are Probei, a QA agent that tests a web application only by looking at screenshots, like a real user.
The browser viewport is ${VIEWPORT.width}x${VIEWPORT.height} pixels and every screenshot has exactly that size.
Coordinates are pixels from the top-left corner of the screenshot. Click the center of the element you need.

Each turn you get the scenario, the history of your previous actions and the current screenshot.
Reply with ONLY one JSON object, no other text:
{"thought": "<one or two short sentences>", "action": <one action>}

Actions:
- {"type":"click","x":<int>,"y":<int>,"target":"<what you click>"}
- {"type":"type","text":"<text>"}   (types into the focused field; click the field first)
- {"type":"press","key":"Enter"}     (Playwright key names: Enter, Tab, Escape, Backspace, ArrowDown...)
- {"type":"scroll","dy":<pixels, positive = down>}
- {"type":"wait","ms":<up to 10000>}
- {"type":"done","summary":"<what you verified>"}  — every step of the scenario works as expected
- {"type":"bug","title":"...","severity":"critical|major|minor","expected":"...","actual":"...","summary":"..."}

Report a bug when the app contradicts the scenario's expected result or is plainly wrong:
wrong totals or numbers, a button that does nothing, missing validation, lost data, error messages, crashes.
Do not report design opinions. Check numbers carefully before saying "done".
Write thought, summary and bug texts in the same language as the scenario.`;

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Validates the model's JSON and turns it into a typed action. */
export function parseDecision(data: unknown): { thought: string; action: Action } {
  if (!data || typeof data !== 'object') throw new Error('decision is not an object');
  const d = data as Record<string, unknown>;
  const a = d.action as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object') throw new Error('missing "action"');
  const thought = str(d.thought);

  switch (a.type) {
    case 'click':
      if (!isNum(a.x) || !isNum(a.y)) throw new Error('click needs numeric x and y');
      return {
        thought,
        action: {
          type: 'click',
          x: Math.max(0, Math.min(VIEWPORT.width - 1, Math.round(a.x))),
          y: Math.max(0, Math.min(VIEWPORT.height - 1, Math.round(a.y))),
          target: str(a.target) || undefined,
        },
      };
    case 'type':
      if (typeof a.text !== 'string') throw new Error('type needs text');
      return { thought, action: { type: 'type', text: a.text } };
    case 'press':
      if (!str(a.key)) throw new Error('press needs key');
      return { thought, action: { type: 'press', key: str(a.key) } };
    case 'scroll':
      return { thought, action: { type: 'scroll', dy: isNum(a.dy) ? a.dy : 400 } };
    case 'wait':
      return { thought, action: { type: 'wait', ms: isNum(a.ms) ? a.ms : 1000 } };
    case 'done':
      return { thought, action: { type: 'done', summary: str(a.summary) } };
    case 'bug': {
      const severity: Severity = a.severity === 'critical' || a.severity === 'minor' ? a.severity : 'major';
      return {
        thought,
        action: {
          type: 'bug',
          title: str(a.title) || 'Untitled bug',
          severity,
          expected: str(a.expected),
          actual: str(a.actual),
          summary: str(a.summary),
        },
      };
    }
    default:
      throw new Error(`unknown action type "${String(a.type)}"`);
  }
}

function describe(action: Action): string {
  switch (action.type) {
    case 'click':
      return `click (${action.x}, ${action.y})${action.target ? ` on "${action.target}"` : ''}`;
    case 'type':
      return `type "${action.text}"`;
    case 'press':
      return `press ${action.key}`;
    case 'scroll':
      return `scroll ${action.dy}px`;
    case 'wait':
      return `wait ${action.ms}ms`;
    case 'done':
      return `done: ${action.summary}`;
    case 'bug':
      return `bug: ${action.title}`;
  }
}

function historyText(steps: Step[]): string {
  if (steps.length === 0) return 'No actions yet.';
  return steps
    .slice(-12)
    .map((s) => {
      const parts = [`${s.n}. ${s.action ? describe(s.action) : 'no action'}`];
      if (s.note) parts.push(`(${s.note})`);
      if (s.errors.length) parts.push(`[errors after this step: ${s.errors.join(' | ')}]`);
      return parts.join(' ');
    })
    .join('\n');
}

export interface RunOptions {
  url: string;
  scenario: string;
  runDir: string;
  maxSteps: number;
  headless: boolean;
  onStep?: (step: Step) => void;
}

/** Runs the screenshot → decide → act → check loop until done, bug, stuck or step limit. */
export async function runScenario(opts: RunOptions): Promise<RunResult> {
  const { provider, model } = llmInfo();
  const startedAt = new Date();
  const steps: Step[] = [];
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  const result: RunResult = {
    status: 'max_steps',
    url: opts.url,
    scenario: opts.scenario,
    provider,
    model,
    steps,
    usage,
    startedAt: startedAt.toISOString(),
    durationMs: 0,
  };

  let session: BrowserSession | undefined;
  try {
    session = await BrowserSession.start(opts.url, opts.runDir, opts.headless);
    let pendingErrors = session.takeErrors();

    for (let n = 1; n <= opts.maxSteps; n++) {
      const shotName = `step-${String(n).padStart(2, '0')}.png`;
      const png = await session.screenshot(join(opts.runDir, shotName));

      const prompt = [
        `Scenario:\n${opts.scenario}`,
        `Step ${n} of at most ${opts.maxSteps}.`,
        `History:\n${historyText(steps)}`,
        pendingErrors.length ? `Errors seen on the page just now:\n${pendingErrors.join('\n')}` : '',
        'Here is the current screenshot.',
      ]
        .filter(Boolean)
        .join('\n\n');

      const step: Step = { n, thought: '', action: null, screenshot: shotName, errors: [] };
      try {
        const reply = await askJSON(SYSTEM_PROMPT, prompt, png);
        usage.promptTokens += reply.usage.promptTokens;
        usage.completionTokens += reply.usage.completionTokens;
        const decision = parseDecision(reply.data);
        step.thought = decision.thought;
        step.action = decision.action;
      } catch (err) {
        step.note = `invalid decision: ${(err as Error).message}`;
        steps.push(step);
        opts.onStep?.(step);
        continue;
      }

      const action = step.action!;
      switch (action.type) {
        case 'click':
          await session.click(action.x, action.y);
          break;
        case 'type':
          await session.type(action.text);
          break;
        case 'press':
          await session.press(action.key);
          break;
        case 'scroll':
          await session.scroll(action.dy);
          break;
        case 'wait':
          await session.wait(action.ms);
          break;
        case 'done':
          result.status = 'passed';
          result.summary = action.summary;
          break;
        case 'bug':
          result.status = 'bug';
          result.bug = action;
          result.summary = action.summary;
          break;
      }

      pendingErrors = session.takeErrors();
      step.errors = pendingErrors;
      steps.push(step);
      opts.onStep?.(step);

      if (action.type === 'done' || action.type === 'bug') break;

      // Stop if the agent repeats the same action three times in a row.
      const last3 = steps.slice(-3).map((s) => JSON.stringify(s.action));
      if (last3.length === 3 && last3.every((a) => a === last3[0])) {
        result.status = 'stuck';
        result.summary = 'The agent repeated the same action three times without progress.';
        break;
      }
    }
  } catch (err) {
    result.status = 'error';
    result.error = (err as Error).message;
  } finally {
    if (session) result.video = await session.close().catch(() => undefined);
    result.durationMs = Date.now() - startedAt.getTime();
  }
  return result;
}
