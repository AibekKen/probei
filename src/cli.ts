import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runScenario } from './agent.js';
import { getAgentConfig } from './config.js';
import { writeReport } from './report.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    scenario: { type: 'string' },
    'max-steps': { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});

if (!values.url || !values.scenario) {
  console.error(
    'Usage: npm run probe -- --url <url> --scenario "<what to test and what is expected>" [--max-steps 25] [--headed]',
  );
  process.exit(1);
}

const agentConfig = getAgentConfig();
const maxSteps = values['max-steps'] ? Number.parseInt(values['max-steps'], 10) : agentConfig.maxSteps;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join('runs', runId);
await mkdir(runDir, { recursive: true });

console.log(`Probei run ${runId}\nURL: ${values.url}\nScenario: ${values.scenario}\n`);

const result = await runScenario({
  url: values.url,
  scenario: values.scenario,
  runDir,
  maxSteps,
  headless: values.headed ? false : agentConfig.headless,
  onStep: (s) => {
    const what = s.action ? JSON.stringify(s.action) : s.note ?? 'no action';
    console.log(`#${s.n} ${s.thought}\n    ${what}`);
  },
});

const { md } = await writeReport(runDir, result);
console.log(`\nStatus: ${result.status}${result.bug ? ` — ${result.bug.title} (${result.bug.severity})` : ''}`);
if (result.error) console.log(`Error: ${result.error}`);
console.log(`Report: ${md}`);
process.exit(result.status === 'error' ? 1 : 0);
