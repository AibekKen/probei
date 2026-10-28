/* Pure helpers for the Probei web UI: matching runs to saved scenarios.
 * No DOM here, so node tests can import this file.
 * Runs are shaped like the server's RunSummary:
 * { id, projectId, scenarioId, status, url, scenario, startedAt, steps, bugTitle }
 * Projects: { id, name, url, scenarios: [{ id, title, text, url, source }] }
 */

/** Collapse whitespace so trivially different scenario texts match. */
export function normalizeScenario(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

export function isHttpUrl(value) {
  try {
    const u = new URL(String(value ?? '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? '');
  }
}

function firstLine(text, max = 80) {
  const line = String(text ?? '').trim().split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function byNewest(a, b) {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/**
 * Does this run belong to the scenario? Linked runs match by id; older runs
 * (started before projects existed) match by start URL and scenario text.
 */
export function runMatches(run, scenario) {
  if (run.scenarioId) return run.scenarioId === scenario.id;
  return (
    String(run.url).trim() === scenario.url && normalizeScenario(run.scenario) === normalizeScenario(scenario.text)
  );
}

/**
 * Splits runs into per-scenario lists (newest first) and the runs that match
 * no saved scenario. Returns { byScenario: Map<scenarioId, run[]>, unassigned: run[] }.
 */
export function assignRuns(runs, projects) {
  const byScenario = new Map();
  const unassigned = [];
  const scenarios = projects.flatMap((p) => p.scenarios);
  for (const s of scenarios) byScenario.set(s.id, []);
  for (const run of [...runs].sort(byNewest)) {
    const owner = scenarios.find((s) => runMatches(run, s));
    if (owner) byScenario.get(owner.id).push(run);
    else unassigned.push(run);
  }
  return { byScenario, unassigned };
}

/** Latest run status per project, for the sidebar dot: running > queued > newest. */
export function projectStatus(project, byScenario) {
  let latest = null;
  let queued = false;
  for (const s of project.scenarios) {
    for (const r of byScenario.get(s.id) ?? []) {
      if (r.status === 'running') return 'running';
      if (r.status === 'queued') queued = true;
      else if (!latest || byNewest(r, latest) < 0) latest = r;
    }
  }
  if (queued) return 'queued';
  return latest ? latest.status : null;
}

/**
 * Groups unassigned runs by (URL, scenario text) so each group can be saved
 * into a project as one scenario. Most recently run group first.
 */
export function groupByScenario(runs) {
  const groups = new Map();
  for (const run of [...runs].sort(byNewest)) {
    const url = String(run.url).trim();
    const key = `${url}\n${normalizeScenario(run.scenario)}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: firstLine(run.scenario) || '(empty scenario)', url, scenario: run.scenario, items: [] };
      groups.set(key, group);
    }
    group.items.push(run);
  }
  return [...groups.values()];
}

/** The project whose URL shares the run's origin, if any: the default target when saving a run. */
export function projectForUrl(projects, url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  return projects.find((p) => hostOrigin(p.url) === origin) ?? null;
}

function hostOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

// --- Outcomes: what a run says about the app, not just how it ended ---

/** Run statuses where the agent could not finish; they say nothing certain about the app. */
export const INCOMPLETE = new Set(['error', 'stuck', 'max_steps']);

/**
 * Bucket for a scenario's latest run: 'pending' (queued/running), 'passed',
 * 'bug' (the app is broken), 'incomplete' (the agent did not finish) or 'not_run'.
 */
export function outcomeOf(run) {
  if (!run) return 'not_run';
  if (run.status === 'running' || run.status === 'queued') return 'pending';
  if (run.status === 'passed' || run.status === 'bug') return run.status;
  return 'incomplete';
}

/** Counts of scenario outcomes in a project, from each scenario's latest run. */
export function summarize(project, byScenario) {
  const counts = { total: 0, passed: 0, bug: 0, incomplete: 0, not_run: 0, pending: 0 };
  for (const s of project.scenarios) {
    counts.total++;
    counts[outcomeOf(byScenario.get(s.id)?.[0])]++;
  }
  return counts;
}

/**
 * Splits a scenario into steps and the expected result for compact display.
 * A leading "Open <start url>." is dropped: every row would repeat it.
 */
export function splitScenario(text, url) {
  let steps = String(text ?? '').trim();
  const lead = /^(open|go to|navigate to|visit)\s+(\S+?)\.?(\s+|$)/i.exec(steps);
  if (lead && sameUrl(lead[2], url)) steps = steps.slice(lead[0].length);
  const at = steps.search(/\bexpected\s*:/i);
  if (at === -1) return { steps: steps.trim(), expected: '' };
  return {
    steps: steps.slice(0, at).trim(),
    expected: steps.slice(at).replace(/^expected\s*:\s*/i, '').trim(),
  };
}

function sameUrl(a, b) {
  const norm = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Auto-drafted by the latest review and never run yet: worth a "new" tag. */
export function isNewScenario(scenario, project, runs) {
  if (scenario.source !== 'auto' || (runs && runs.length) || !project.lastReview) return false;
  // Scenarios are saved a moment before the review timestamp is written.
  return Date.parse(scenario.createdAt) >= Date.parse(project.lastReview.at) - 60_000;
}
