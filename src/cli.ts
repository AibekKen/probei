import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { describeAction, runScenario } from './agent.js';
import { getAgentConfig } from './config.js';
import { writeReport } from './report.js';
import { reviewApp, suggestScenarios } from './suggest.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    scenario: { type: 'string' },
    'max-steps': { type: 'string' },
    headed: { type: 'boolean', default: false },
    suggest: { type: 'boolean', default: false },
    'max-pages': { type: 'string' },
  },
});

if (values.suggest) {
  if (!values.url) {
    console.error('Usage: npm run probe -- --url <url> --suggest [--max-pages 6]');
    process.exit(1);
  }
  const agentConfig = getAgentConfig();
  const maxPages = values['max-pages'] ? Number.parseInt(values['max-pages'], 10) : 6;
  console.log(`Reviewing ${values.url} …`);
  const { review, homeScreenshot } = await reviewApp({
    url: values.url,
    maxPages,
    headless: values.headed ? false : agentConfig.headless,
  });
  console.log(`Reviewed ${review.pages.length} page(s); drafting scenarios …\n`);
  const { scenarios, usage } = await suggestScenarios(review, homeScreenshot);
  for (const [i, s] of scenarios.entries()) {
    console.log(`${i + 1}. ${s.title}\n   URL: ${s.url}\n   ${s.scenario.split('\n').join('\n   ')}\n`);
  }
  console.log(`Tokens: ${usage.promptTokens} in / ${usage.completionTokens} out`);
  process.exit(0);
}

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
    const what = s.action ? describeAction(s.action) : s.note ?? 'no action';
    console.log(`#${s.n} ${what}\n    ${s.thought}`);
  },
});

const { md } = await writeReport(runDir, result);
console.log(`\nStatus: ${result.status}${result.bug ? ` — ${result.bug.title} (${result.bug.severity})` : ''}`);
if (result.error) console.log(`Error: ${result.error}`);
console.log(`Report: ${md}`);
process.exit(result.status === 'error' ? 1 : 0);
