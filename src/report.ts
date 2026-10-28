import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describeAction, type RunResult } from './agent.js';

const STATUS_TEXT: Record<RunResult['status'], string> = {
  passed: 'Passed',
  bug: 'Bug found',
  stuck: 'Stuck',
  max_steps: 'Step limit reached',
  error: 'Run error',
};

/** Writes report.json (for metrics) and report.md (for people) into the run folder. */
export async function writeReport(runDir: string, result: RunResult): Promise<{ json: string; md: string }> {
  const json = join(runDir, 'report.json');
  const md = join(runDir, 'report.md');
  const video = result.video ? basename(result.video) : undefined;

  await writeFile(json, JSON.stringify({ ...result, video }, null, 2), 'utf8');

  const lines: string[] = [
    `# Probei report: ${STATUS_TEXT[result.status]}`,
    '',
    `- **URL:** ${result.url}`,
    `- **Model:** ${result.model} (${result.provider})`,
    `- **Steps:** ${result.steps.length}`,
    `- **Time:** ${(result.durationMs / 1000).toFixed(1)} s`,
    `- **Tokens:** ${result.usage.promptTokens} in / ${result.usage.completionTokens} out`,
    video ? `- **Video:** ${video}` : '',
    '',
    '## Scenario',
    '',
    result.scenario,
    '',
  ];

  if (result.bug) {
    lines.push(
      `## Bug: ${result.bug.title}`,
      '',
      `- **Severity:** ${result.bug.severity}`,
      `- **Expected:** ${result.bug.expected}`,
      `- **Actual:** ${result.bug.actual}`,
      '',
      result.bug.summary,
      '',
    );
  } else if (result.summary) {
    lines.push('## Summary', '', result.summary, '');
  }
  if (result.error) lines.push('## Error', '', '```', result.error, '```', '');

  lines.push('## Steps to reproduce', '');
  lines.push('_The red target on a screenshot marks where the agent clicked._', '');
  for (const s of result.steps) {
    const what = s.action ? describeAction(s.action) : 'no action';
    lines.push(`${s.n}. **${what}**  `);
    if (s.thought) lines.push(`   _${s.thought}_  `);
    if (s.note) lines.push(`   ${s.note}  `);
    if (s.errors.length) lines.push(`   Errors: ${s.errors.join('; ')}  `);
    lines.push(`   ![step ${s.n}](${s.screenshot})`, '');
  }

  await writeFile(md, lines.filter((l) => l !== undefined).join('\n'), 'utf8');
  return { json, md };
}
