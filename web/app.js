/* Probei workspace: projects (app URLs) → saved scenarios → each scenario's runs.
 * Runs stream live over SSE into the right-hand run pane. */
import {
  assignRuns,
  groupByScenario,
  hostOf,
  INCOMPLETE,
  isHttpUrl,
  isNewScenario,
  outcomeOf,
  projectForUrl,
  projectStatus,
  splitScenario,
  summarize,
} from './lib.js';

const $ = (id) => document.getElementById(id);

const state = {
  projects: [],
  runs: [],
  byScenario: new Map(),
  unassigned: [],
  /** project id, 'unassigned', or null */
  view: null,
  runId: null,
  /** scenario ids whose details are open */
  open: new Set(),
  /** scenario ids showing their whole run history */
  allRuns: new Set(),
  /** scenario list filter: 'all' or an outcome from lib.outcomeOf */
  filter: 'all',
  /** scenario id being edited in the form, or null for a new one */
  editing: null,
};
let source = null;

// --- Small DOM helpers ---

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function button(label, onClick, cls = 'secondary small', title) {
  return el('button', { type: 'button', class: cls, text: label, title, onclick: onClick });
}

function badge(status) {
  return el('span', { class: `badge ${status}`, text: STATUS_TEXT[status] ?? status, title: STATUS_HINT[status] });
}

/** Badge for a scenario's latest outcome: app bug and unfinished run look different on purpose. */
function outcomeBadge(run) {
  const outcome = outcomeOf(run);
  if (outcome === 'pending') return badge(run.status);
  const text = { passed: 'passed', bug: 'bug', incomplete: 'incomplete', not_run: 'not run' }[outcome];
  const title = outcome === 'incomplete' ? `Probei did not finish (${STATUS_TEXT[run.status]}); not a confirmed app bug` : undefined;
  return el('span', { class: `badge ${outcome}`, text, title });
}

const STATUS_HINT = {
  stuck: 'Probei got stuck; not a confirmed app bug',
  max_steps: 'Probei ran out of steps; not a confirmed app bug',
  error: 'The run failed to complete; not a confirmed app bug',
};

const STATUS_TEXT = {
  queued: 'queued',
  running: 'running',
  passed: 'passed',
  bug: 'bug',
  stuck: 'stuck',
  max_steps: 'step limit',
  error: 'error',
};

function showError(id, msg) {
  const box = $(id);
  box.hidden = !msg;
  box.textContent = msg || '';
}

function fmtElapsed(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

// --- Location hash keeps the open project and run across reloads ---

function writeHash() {
  const params = new URLSearchParams();
  if (state.view) params.set('project', state.view);
  if (state.runId) params.set('run', state.runId);
  const next = params.toString();
  if (location.hash.slice(1) !== next) history.replaceState(null, '', next ? `#${next}` : location.pathname);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { project: params.get('project'), run: params.get('run') };
}

// --- Data ---

function currentProject() {
  return state.projects.find((p) => p.id === state.view) ?? null;
}

const PENDING = new Set(['running', 'queued']);

/** Is this saved scenario waiting in the queue or running right now? */
function scenarioPending(scenarioId) {
  const last = state.byScenario.get(scenarioId)?.[0];
  return Boolean(last && PENDING.has(last.status));
}

// While runs are queued or running, poll so every card's badge stays current.
let pollTimer = null;
function schedulePoll() {
  const pending = state.runs.some((r) => PENDING.has(r.status));
  if (pending && !pollTimer) pollTimer = setInterval(() => void refresh({ poll: true }), 4000);
  if (!pending && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function reassign() {
  const { byScenario, unassigned } = assignRuns(state.runs, state.projects);
  state.byScenario = byScenario;
  state.unassigned = unassigned;
}

async function loadProjects() {
  state.projects = (await api('GET', '/api/projects')).projects;
}

async function loadRuns() {
  state.runs = await api('GET', '/api/runs');
}

let lastData = '';

async function refresh({ poll = false } = {}) {
  try {
    await Promise.all([loadProjects(), loadRuns()]);
  } catch (err) {
    showError('project-error', `Could not load data: ${err.message}`);
  }
  // A poll that changed nothing leaves the page alone, so expanded texts and focus survive.
  const data = JSON.stringify([state.projects, state.runs]);
  if (poll && data === lastData) return;
  lastData = data;
  reassign();
  if (state.view && state.view !== 'unassigned' && !currentProject()) state.view = null;
  if (state.view === 'unassigned' && !state.unassigned.length) state.view = null;
  if (!state.view && state.projects.length) state.view = state.projects[0].id;
  render();
  schedulePoll();
}

// --- Rendering ---

function render() {
  renderProjectList();
  renderMain();
  const owner = state.runId ? ownerOf(state.runId) : null;
  $('run-again').disabled = Boolean(owner && scenarioPending(owner.scenario.id));
  if (state.runId) updateProgress();
  writeHash();
}

function renderProjectList() {
  const nav = $('project-list');
  nav.innerHTML = '';
  for (const p of state.projects) {
    const status = projectStatus(p, state.byScenario);
    const item = el(
      'button',
      {
        type: 'button',
        class: `nav-item${state.view === p.id ? ' active' : ''}`,
        title: p.url,
        onclick: () => selectView(p.id),
      },
      el('span', { class: `dot ${status ?? 'none'}`, title: status ? `Last run: ${status}` : 'No runs yet' }),
      el('span', { class: 'nav-text' }, el('span', { class: 'nav-name', text: p.name }), el('span', { class: 'nav-sub', text: hostOf(p.url) })),
      el('span', { class: 'count', text: String(p.scenarios.length) }),
    );
    nav.append(item);
  }
  const un = $('unassigned-btn');
  un.hidden = !state.unassigned.length;
  un.classList.toggle('active', state.view === 'unassigned');
  $('unassigned-count').textContent = String(state.unassigned.length);
}

function selectView(view) {
  if (state.view !== view) {
    state.view = view;
    closeScenarioForm();
    $('review-status').textContent = '';
    showError('project-error', null);
    // The run pane follows the project: its latest run, or closed when it has none.
    const latest = latestRun(currentProject());
    if (latest) openRun(latest.id);
    else closeRun();
  }
  render();
}

/** Newest run of any scenario in the project, or null. */
function latestRun(project) {
  if (!project) return null;
  let latest = null;
  for (const s of project.scenarios) {
    const r = state.byScenario.get(s.id)?.[0];
    if (r && (!latest || r.startedAt > latest.startedAt)) latest = r;
  }
  return latest;
}

function renderMain() {
  const project = currentProject();
  $('project-empty').hidden = Boolean(state.view);
  $('project-view').hidden = !project;
  $('unassigned-view').hidden = state.view !== 'unassigned';
  if (project) renderProject(project);
  if (state.view === 'unassigned') renderUnassigned();
}

function renderProject(project) {
  $('project-name').textContent = project.name;
  $('project-url').textContent = project.url;
  $('project-url').href = project.url;
  $('review-btn').disabled = reviewing;
  $('run-all-btn').disabled = !project.scenarios.length;
  renderQueue(project);
  if (!reviewing && !$('review-status').textContent && project.lastReview) {
    const r = project.lastReview;
    $('review-status').textContent = `Last auto-review ${fmtTime(r.at)}: ${r.pages} page(s), ${r.added} new scenario(s).`;
  }

  const list = $('scenario-list');
  list.innerHTML = '';
  renderSummary(project);
  if (!project.scenarios.length) {
    list.append(
      el(
        'div',
        { class: 'empty inline-empty' },
        el('h3', { text: 'No scenarios yet' }),
        el('p', { text: 'Let Probei walk the app and draft scenarios, or write your own.' }),
        el(
          'div',
          { class: 'actions center' },
          el('button', { type: 'button', text: 'Auto-review the app', disabled: reviewing, onclick: () => void autoReview() }),
          button('+ Write a scenario', () => openScenarioForm(null), 'secondary'),
        ),
      ),
    );
    return;
  }
  const shown = project.scenarios.filter(
    (s) => state.filter === 'all' || outcomeOf(state.byScenario.get(s.id)?.[0]) === state.filter,
  );
  if (!shown.length) {
    list.append(el('p', { class: 'msg filter-empty', text: 'No scenarios match this filter.' }));
    return;
  }
  for (const s of shown) list.append(scenarioRow(project, s));
}

const FILTERS = [
  ['all', 'All'],
  ['bug', 'Bug'],
  ['incomplete', 'Incomplete'],
  ['passed', 'Passed'],
  ['not_run', 'Not run'],
  ['pending', 'In queue'],
];

/** One line of counts that doubles as the filter. */
function renderSummary(project) {
  const bar = $('project-summary');
  bar.innerHTML = '';
  bar.hidden = !project.scenarios.length;
  if (bar.hidden) return;
  const counts = summarize(project, state.byScenario);
  if (state.filter !== 'all' && !counts[state.filter]) state.filter = 'all';
  for (const [key, label] of FILTERS) {
    const n = key === 'all' ? counts.total : counts[key];
    if (key !== 'all' && !n) continue;
    bar.append(
      el(
        'button',
        {
          type: 'button',
          class: `chip ${key}${state.filter === key ? ' on' : ''}`,
          'aria-pressed': String(state.filter === key),
          onclick: () => {
            state.filter = key;
            render();
          },
        },
        el('span', { text: label }),
        el('span', { class: 'chip-n', text: String(n) }),
      ),
    );
  }
}

/** "Queue: 1 running, 4 waiting" for this project, with a cancel button. */
function renderQueue(project) {
  const box = $('queue-status');
  box.innerHTML = '';
  const ids = new Set(project.scenarios.map((s) => s.id));
  const mine = state.runs.filter((r) => r.projectId === project.id && ids.has(r.scenarioId));
  const running = mine.filter((r) => r.status === 'running').length;
  const waiting = mine.filter((r) => r.status === 'queued').length;
  box.hidden = !running && !waiting;
  if (box.hidden) return;
  const parts = [];
  if (running) parts.push(`${running} running`);
  if (waiting) parts.push(`${waiting} waiting`);
  box.append(el('span', { text: `Queue: ${parts.join(', ')}` }));
  if (waiting) box.append(button('Cancel waiting', () => void cancelQueue(project), 'link small'));
}

/** One compact row per scenario; details and run history open in place. */
function scenarioRow(project, s) {
  const runs = state.byScenario.get(s.id) ?? [];
  const last = runs[0];
  const open = state.open.has(s.id);
  const { steps, expected } = splitScenario(s.text, s.url);
  const toggle = () => {
    if (open) state.open.delete(s.id);
    else state.open.add(s.id);
    render();
  };

  const main = el(
    'button',
    { type: 'button', class: 'scn-main', 'aria-expanded': String(open), onclick: toggle },
    el(
      'span',
      { class: 'scn-title' },
      el('span', { text: s.title }),
      isNewScenario(s, project, runs) ? el('span', { class: 'tag', text: 'new', title: 'Drafted by the latest auto-review' }) : null,
    ),
    el('span', { class: 'scn-sub', text: expected ? `Expected: ${expected}` : steps }),
  );
  const pending = scenarioPending(s.id);
  const row = el(
    'div',
    { class: 'scn-row' },
    outcomeBadge(last),
    main,
    el('span', { class: 'scn-when', text: last && !pending ? fmtTime(last.startedAt) : '' }),
    el(
      'div',
      { class: 'row-actions' },
      el(
        'button',
        { type: 'button', class: 'small run-btn', disabled: pending, onclick: () => void startRun(project, s) },
        icon('play'),
        el('span', { text: last?.status === 'running' ? 'Running…' : last?.status === 'queued' ? 'Queued' : 'Run' }),
      ),
      iconButton('edit', `Edit scenario ${s.title}`, () => openScenarioForm(s)),
      iconButton('trash', `Delete scenario ${s.title}`, () => void deleteScenario(project, s), 'danger'),
    ),
  );
  const item = el('article', { class: `scn${open ? ' open' : ''}${last ? ` ${outcomeOf(last)}` : ''}` }, row);
  if (!open) return item;

  const detail = el('div', { class: 'scn-detail' });
  if (steps) detail.append(el('p', { class: 'scn-steps', text: steps }));
  if (expected) detail.append(el('p', { class: 'scn-expected' }, el('strong', { text: 'Expected: ' }), expected));
  const meta = [s.url !== project.url ? `Starts at ${s.url}` : null, s.source === 'auto' ? 'Drafted by auto-review' : null].filter(Boolean);
  if (meta.length) detail.append(el('p', { class: 'scn-meta', text: meta.join(' · ') }));
  if (runs.length) {
    const showAll = state.allRuns.has(s.id);
    const hist = el('div', { class: 'runs' });
    for (const r of showAll ? runs : runs.slice(0, 3)) hist.append(runRow(r));
    if (runs.length > 3) {
      hist.append(
        button(showAll ? 'Show fewer' : `Show all ${runs.length} runs`, () => {
          if (showAll) state.allRuns.delete(s.id);
          else state.allRuns.add(s.id);
          render();
        }, 'link small'),
      );
    }
    detail.append(hist);
  } else {
    detail.append(el('p', { class: 'scn-meta', text: 'Not run yet.' }));
  }
  item.append(detail);
  return item;
}

// Line icons (Lucide shapes), drawn with currentColor so they follow the button's color.
const ICONS = {
  play: '<path d="M6 4l14 8-14 8z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
};

function icon(name) {
  const span = el('span', { class: `icon-svg ${name}`, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

/** Icon-only button; the label goes to screen readers and the tooltip. */
function iconButton(name, label, onClick, kind = 'secondary') {
  return el('button', { type: 'button', class: `icon-btn ${kind}`, 'aria-label': label, title: label.split(' ')[0], onclick: onClick }, icon(name));
}

// Only one menu open at a time; a click elsewhere closes it.
document.addEventListener('click', (e) => {
  for (const m of document.querySelectorAll('details.menu[open]')) if (!m.contains(e.target)) m.open = false;
});

function runRow(r) {
  const bits = [fmtTime(r.startedAt), `${r.steps} steps`];
  return el(
    'button',
    {
      type: 'button',
      class: `run-row${state.runId === r.id ? ' active' : ''}`,
      onclick: () => openRun(r.id),
    },
    badge(r.status),
    el('span', { class: 'run-when', text: bits.join(' · ') }),
    r.bugTitle ? el('span', { class: 'run-bug', text: r.bugTitle, title: r.bugTitle }) : null,
  );
}

function renderUnassigned() {
  const list = $('unassigned-list');
  list.innerHTML = '';
  for (const g of groupByScenario(state.unassigned)) {
    const guess = projectForUrl(state.projects, g.url);
    const select = el('select', { 'aria-label': 'Project to save into' });
    for (const p of state.projects) select.append(el('option', { value: p.id, text: p.name, selected: guess?.id === p.id }));
    select.append(el('option', { value: '__new', text: `New project: ${hostOf(g.url)}`, selected: !guess }));
    const save = button('Save as scenario', () => void saveGroup(g, select.value), 'small');
    const card = el(
      'article',
      { class: 'scenario' },
      el('div', { class: 'scenario-head' }, el('div', { class: 'scenario-title' }, el('strong', { text: g.label }), el('span', { class: 'count', text: String(g.items.length) }))),
      el('div', { class: 'scenario-text', text: g.scenario }),
      el('div', { class: 'scenario-meta', text: g.url }),
      el('div', { class: 'actions save-row' }, select, save),
      el('div', { class: 'runs' }, ...g.items.slice(0, 5).map(runRow)),
    );
    list.append(card);
  }
}

// --- Projects ---

function openNewProject() {
  $('new-project').hidden = false;
  showError('np-error', null);
  $('np-url').focus();
}

$('new-project-btn').addEventListener('click', openNewProject);
$('empty-new-project').addEventListener('click', openNewProject);
$('np-cancel').addEventListener('click', () => {
  $('new-project').hidden = true;
});
$('new-project').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('np-url').value.trim();
  if (!isHttpUrl(url)) {
    showError('np-error', 'Enter an http(s) URL.');
    return;
  }
  try {
    const project = await api('POST', '/api/projects', { url, name: $('np-name').value });
    $('new-project').reset();
    $('new-project').hidden = true;
    state.view = project.id;
    await refresh();
  } catch (err) {
    showError('np-error', err.message);
  }
});

$('unassigned-btn').addEventListener('click', () => selectView('unassigned'));

$('rename-project').addEventListener('click', async () => {
  const project = currentProject();
  $('rename-project').closest('details').open = false;
  const name = prompt('Project name', project.name);
  if (!name?.trim()) return;
  await patchProject(project, { name });
});

$('edit-project-url').addEventListener('click', async () => {
  const project = currentProject();
  $('edit-project-url').closest('details').open = false;
  const url = prompt('App URL', project.url);
  if (!url?.trim() || url.trim() === project.url) return;
  await patchProject(project, { url });
});

async function patchProject(project, body) {
  try {
    await api('PATCH', `/api/projects/${project.id}`, body);
    await refresh();
  } catch (err) {
    showError('project-error', err.message);
  }
}

$('delete-project').addEventListener('click', async () => {
  const project = currentProject();
  $('delete-project').closest('details').open = false;
  if (!confirm(`Delete project "${project.name}" and its ${project.scenarios.length} scenario(s)? Run reports stay in runs/.`)) return;
  try {
    await api('DELETE', `/api/projects/${project.id}`);
    state.view = null;
    closeRun();
    await refresh();
  } catch (err) {
    showError('project-error', err.message);
  }
});

// --- Auto-review ---

let reviewing = false;

async function autoReview() {
  const project = currentProject();
  if (!project || reviewing) return;
  reviewing = true;
  showError('project-error', null);
  const started = Date.now();
  const tick = () => {
    $('review-status').textContent = `Reviewing the app: walking its pages and drafting scenarios… ${fmtElapsed(Date.now() - started)} (usually 1–3 min)`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  $('review-status').classList.add('working');
  render();
  try {
    const data = await api('POST', `/api/projects/${project.id}/review`);
    if (data.added.length) state.filter = 'all';
    $('review-status').textContent = data.added.length
      ? `Reviewed ${data.pagesReviewed} page(s): added ${data.added.length} scenario(s), marked new.`
      : `Reviewed ${data.pagesReviewed} page(s): no new scenarios (all ${data.drafted} drafts were already saved).`;
  } catch (err) {
    $('review-status').textContent = '';
    showError('project-error', `Auto-review failed: ${err.message}`);
  } finally {
    clearInterval(timer);
    reviewing = false;
    $('review-status').classList.remove('working');
    await refresh();
  }
}

$('review-btn').addEventListener('click', () => void autoReview());

// --- Run all: queue every scenario of the project; the server runs them one by one ---

$('run-all-btn').addEventListener('click', async () => {
  const project = currentProject();
  if (!project) return;
  showError('project-error', null);
  try {
    const { ids } = await api('POST', `/api/projects/${project.id}/run-all`, { maxSteps: Number($('max-steps').value) });
    await refresh();
    if (!ids.length) showError('project-error', 'Every scenario is already queued or running.');
    else if (!state.runId || !state.runs.some((r) => r.id === state.runId && PENDING.has(r.status))) openRun(ids[0]);
  } catch (err) {
    showError('project-error', err.message);
  }
});

async function cancelQueue(project) {
  try {
    await api('DELETE', `/api/projects/${project.id}/queue`);
    await refresh();
  } catch (err) {
    showError('project-error', err.message);
  }
}

// --- Scenarios ---

function openScenarioForm(scenario) {
  const project = currentProject();
  state.editing = scenario?.id ?? null;
  $('scenario-form-title').textContent = scenario ? 'Edit scenario' : 'New scenario';
  $('sc-title').value = scenario?.title ?? '';
  $('sc-text').value = scenario?.text ?? '';
  $('sc-url').value = scenario && scenario.url !== project.url ? scenario.url : '';
  $('sc-url').placeholder = project.url;
  showError('sc-error', null);
  $('scenario-form').hidden = false;
  $('scenario-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('sc-text').focus();
}

function closeScenarioForm() {
  $('scenario-form').hidden = true;
  state.editing = null;
}

$('add-scenario-btn').addEventListener('click', () => openScenarioForm(null));
$('sc-cancel').addEventListener('click', closeScenarioForm);

async function saveScenario() {
  const project = currentProject();
  const body = { title: $('sc-title').value, text: $('sc-text').value, url: $('sc-url').value.trim() };
  if (!body.text.trim()) {
    showError('sc-error', 'Write the scenario first.');
    return null;
  }
  if (body.url && !isHttpUrl(body.url)) {
    showError('sc-error', 'Start URL must be an http(s) URL.');
    return null;
  }
  try {
    const saved = state.editing
      ? await api('PATCH', `/api/projects/${project.id}/scenarios/${state.editing}`, body)
      : await api('POST', `/api/projects/${project.id}/scenarios`, body);
    closeScenarioForm();
    await refresh();
    return saved;
  } catch (err) {
    showError('sc-error', err.message);
    return null;
  }
}

$('sc-save').addEventListener('click', () => void saveScenario());
$('scenario-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const project = currentProject();
  const saved = await saveScenario();
  if (saved) await startRun(project, saved);
});

async function deleteScenario(project, s) {
  if (!confirm(`Delete scenario "${s.title}"? Its run reports stay in runs/ and move to Unsorted runs.`)) return;
  try {
    await api('DELETE', `/api/projects/${project.id}/scenarios/${s.id}`);
    await refresh();
  } catch (err) {
    showError('project-error', err.message);
  }
}

async function saveGroup(group, target) {
  try {
    let projectId = target;
    if (target === '__new') projectId = (await api('POST', '/api/projects', { url: group.url })).id;
    await api('POST', `/api/projects/${projectId}/scenarios`, { text: group.scenario, url: group.url });
    state.view = projectId;
    await refresh();
  } catch (err) {
    alert(err.message);
  }
}

// --- Runs ---

let lastStarted = null;

async function startRun(project, s) {
  showError('project-error', null);
  try {
    const data = await api('POST', '/api/runs', {
      url: s.url,
      scenario: s.text,
      projectId: project.id,
      scenarioId: s.id,
      maxSteps: Number($('max-steps').value),
    });
    lastStarted = { project, scenario: s };
    await refresh();
    openRun(data.id);
  } catch (err) {
    showError('project-error', err.message);
  }
}

function closeStream() {
  if (source) {
    source.close();
    source = null;
  }
}

function describeAction(a) {
  switch (a.type) {
    case 'click':
      return `click (${a.x}, ${a.y})${a.target ? ` on "${a.target}"` : ''}`;
    case 'type':
      return `type "${a.text}"${a.clear ? ' (replacing field text)' : ''}`;
    case 'press':
      return `press ${a.key}`;
    case 'scroll':
      return `scroll ${a.dy}px`;
    case 'wait':
      return `wait ${a.ms}ms`;
    case 'done':
      return `done: ${a.summary}`;
    case 'bug':
      return `bug: ${a.title}`;
    default:
      return JSON.stringify(a);
  }
}

function appendStep(runId, step) {
  const body = el('div', { class: 'step-body' });
  const head = el('div', { class: 'step-head' }, el('strong', { text: `Step ${step.n}` }));
  if (step.note) head.append(el('span', { class: 'msg', text: step.note }));
  body.append(head);
  if (step.action?.type === 'done' || step.action?.type === 'bug') {
    // The verdict above already shows the full text; here a short marker is enough.
    const text = step.action.type === 'done' ? 'Finished: scenario passed' : `Reported bug: ${step.action.title}`;
    body.append(el('p', { class: `final ${step.action.type}`, text }));
  } else if (step.action) {
    body.append(el('code', { class: 'action', text: describeAction(step.action), title: JSON.stringify(step.action) }));
  }
  if (step.thought) body.append(el('p', { class: 'thought', text: step.thought }));
  for (const e of step.errors ?? []) body.append(el('p', { class: 'msg error', text: e }));

  const div = el('div', { class: 'step' });
  if (step.screenshot) {
    const index = shots.length;
    const src = `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(step.screenshot)}`;
    const what = step.action ? describeAction(step.action) : '';
    shots.push({ src, caption: `Step ${step.n}${what ? ` · ${what.length > 120 ? `${what.slice(0, 119)}…` : what}` : ''}` });
    div.append(
      el(
        'button',
        { type: 'button', class: 'thumb', title: 'Open full size', onclick: () => openLightbox(index) },
        el('img', { src, alt: `screenshot of step ${step.n}`, loading: 'lazy' }),
      ),
    );
  }
  div.append(body);
  $('steps').append(div);
  if (state.live) div.scrollIntoView({ block: 'nearest' });
}

// --- Screenshot viewer ---

/** Screenshots of the open run, in step order, for the viewer's prev/next. */
let shots = [];
let shotIndex = 0;

function openLightbox(index) {
  shotIndex = Math.max(0, Math.min(index, shots.length - 1));
  const shot = shots[shotIndex];
  if (!shot) return;
  stopModalVideo();
  $('lb-img').hidden = false;
  $('lb-prev').hidden = false;
  $('lb-next').hidden = false;
  $('lb-img').src = shot.src;
  $('lb-img').alt = shot.caption;
  $('lb-cap').textContent = `${shot.caption}  (${shotIndex + 1}/${shots.length})`;
  $('lb-prev').disabled = shotIndex === 0;
  $('lb-next').disabled = shotIndex === shots.length - 1;
  $('lightbox').hidden = false;
  $('lb-close').focus();
}

/** The run video, enlarged in the same modal. */
function openVideoModal() {
  const src = $('run-video').getAttribute('src');
  if (!src) return;
  const video = $('lb-video');
  $('lb-img').hidden = true;
  $('lb-prev').hidden = true;
  $('lb-next').hidden = true;
  video.hidden = false;
  if (video.getAttribute('src') !== src) video.src = src;
  $('lb-cap').textContent = 'Run video';
  $('lightbox').hidden = false;
  void video.play().catch(() => undefined);
  $('lb-close').focus();
}

function stopModalVideo() {
  const video = $('lb-video');
  video.pause();
  video.hidden = true;
}

function closeLightbox() {
  stopModalVideo();
  $('lightbox').hidden = true;
}

$('lb-close').addEventListener('click', closeLightbox);
$('lb-prev').addEventListener('click', () => openLightbox(shotIndex - 1));
$('lb-next').addEventListener('click', () => openLightbox(shotIndex + 1));
$('lightbox').addEventListener('click', (e) => {
  if (e.target === $('lightbox') || e.target.tagName === 'FIGURE') closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (!$('lb-video').hidden) return;
  else if (e.key === 'ArrowLeft') openLightbox(shotIndex - 1);
  else if (e.key === 'ArrowRight') openLightbox(shotIndex + 1);
});

function setRunStatus(status) {
  const b = $('run-status');
  b.className = `badge ${status}`;
  b.textContent = STATUS_TEXT[status] ?? status;
}

/** One verdict for the run: passed, app bug, or a run Probei could not finish. */
function showVerdict(runId, done) {
  const box = $('run-verdict');
  box.innerHTML = '';
  const kind = done.status === 'passed' ? 'passed' : done.status === 'bug' ? 'bug' : INCOMPLETE.has(done.status) ? 'incomplete' : '';
  box.className = `verdict ${kind}`;
  if (done.bug) {
    box.append(
      el('h3', {}, el('span', { text: `Bug: ${done.bug.title}` }), el('span', { class: `sev ${done.bug.severity}`, text: done.bug.severity })),
      el('dl', {}, el('dt', { text: 'Expected' }), el('dd', { text: done.bug.expected }), el('dt', { text: 'Actual' }), el('dd', { text: done.bug.actual })),
    );
  } else if (kind === 'passed') {
    box.append(el('h3', { text: 'Passed' }));
  } else if (kind === 'incomplete') {
    box.append(
      el('h3', { text: `Did not finish: ${STATUS_TEXT[done.status]}` }),
      el('p', { class: 'msg', text: 'Probei could not complete this scenario, so this is not a confirmed bug in the app.' }),
    );
  }
  // Playwright errors carry terminal color codes; they are noise in the page.
  const detail = (done.error || (!done.bug ? done.summary : '') || '').replace(/\u001b\[[0-9;]*m/g, '');
  if (detail) {
    const p = el('p', { class: `verdict-text${done.error ? ' error' : ''}`, text: detail });
    box.append(p);
    if (detail.length > 220) {
      p.classList.add('clamped');
      const more = button('Show more', () => {
        const clamped = p.classList.toggle('clamped');
        more.textContent = clamped ? 'Show more' : 'Show less';
      }, 'link small');
      box.append(more);
    }
  }
  box.hidden = !box.childNodes.length;
  if (done.video) {
    const url = `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(done.video)}`;
    $('run-video-p').hidden = false;
    $('run-video').src = url;
    $('run-video-link').href = url;
  }
}

// --- Live progress: which step, how long the model has been on it, queue position ---

const progress = { maxSteps: null, steps: 0, stepStart: 0, timer: null };

function startProgress(maxSteps, sinceStepMs) {
  progress.maxSteps = maxSteps;
  progress.stepStart = Date.now() - (sinceStepMs ?? 0);
  if (!progress.timer) progress.timer = setInterval(updateProgress, 1000);
  updateProgress();
}

function stopProgress() {
  clearInterval(progress.timer);
  progress.timer = null;
  $('run-progress').hidden = true;
}

function updateProgress() {
  const line = $('run-progress');
  const run = state.runs.find((r) => r.id === state.runId);
  if (state.live && run?.status === 'queued') {
    const waiting = state.runs.filter((r) => r.status === 'queued').sort((a, z) => (a.id < z.id ? -1 : 1));
    const pos = waiting.findIndex((r) => r.id === run.id) + 1;
    line.textContent = pos ? `Waiting in queue: ${pos} of ${waiting.length}` : 'Waiting in queue';
    line.hidden = false;
    return;
  }
  if (!state.live || !progress.timer) {
    line.hidden = true;
    return;
  }
  const next = progress.steps + 1;
  const of = progress.maxSteps ? ` of ${progress.maxSteps}` : '';
  line.textContent = `Step ${next}${of} · working ${fmtElapsed(Date.now() - progress.stepStart)}`;
  line.hidden = false;
}

/** The saved scenario a run belongs to, if any. */
function ownerOf(runId) {
  for (const p of state.projects) {
    for (const s of p.scenarios) {
      if ((state.byScenario.get(s.id) ?? []).some((r) => r.id === runId)) return { project: p, scenario: s };
    }
  }
  return null;
}

function openRun(id) {
  closeStream();
  state.runId = id;
  const run = state.runs.find((r) => r.id === id);
  const owner = ownerOf(id) ?? (lastStarted && run?.scenarioId === lastStarted.scenario.id ? lastStarted : null);
  showRunPane(true);
  $('run-title').textContent = owner?.scenario.title ?? run?.scenario.split('\n')[0] ?? id;
  $('run-meta').textContent = [run ? fmtTime(run.startedAt) : id, run ? hostOf(run.url) : null].filter(Boolean).join(' · ');
  $('run-report-link').href = `/api/runs/${encodeURIComponent(id)}/report`;
  const again = $('run-again');
  again.hidden = !owner && !run;
  again.disabled = Boolean(owner && scenarioPending(owner.scenario.id));
  again.onclick = () => {
    if (owner) void startRun(owner.project, owner.scenario);
    else if (run) void startUnsaved(run);
  };
  $('steps').innerHTML = '';
  shots = [];
  $('run-verdict').hidden = true;
  $('run-verdict').innerHTML = '';
  stopProgress();
  progress.steps = 0;
  $('run-video-p').hidden = true;
  $('run-video').removeAttribute('src');
  setRunStatus(run && PENDING.has(run.status) ? run.status : '…');
  state.live = Boolean(run && PENDING.has(run.status));
  render();
  updateProgress();
  if (matchMedia('(max-width: 1100px)').matches) $('run-pane').scrollIntoView({ behavior: 'smooth', block: 'start' });

  source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  source.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.type === 'queued') {
      setRunStatus('queued');
      updateProgress();
    } else if (ev.type === 'started') {
      setRunStatus('running');
      startProgress(ev.maxSteps, ev.sinceStepMs);
    } else if (ev.type === 'step') {
      appendStep(id, ev.step);
      progress.steps = ev.step.n;
      progress.stepStart = Date.now();
      if (state.live) {
        setRunStatus('running');
        updateProgress();
      }
    } else if (ev.type === 'done') {
      setRunStatus(ev.status);
      stopProgress();
      showVerdict(id, ev);
      closeStream();
      if (state.live) {
        state.live = false;
        void refresh();
      }
    }
  };
  source.onerror = () => {
    setRunStatus('error');
    stopProgress();
    showVerdict(id, { status: 'error', error: 'Lost connection to the server.' });
    closeStream();
  };
}

function showRunPane(open) {
  $('run-pane').hidden = !open;
  document.querySelector('.workspace').classList.toggle('with-run', open);
}

function closeRun() {
  closeStream();
  stopProgress();
  closeLightbox();
  state.runId = null;
  state.live = false;
  $('run-video').removeAttribute('src');
  $('lb-video').removeAttribute('src');
  showRunPane(false);
  writeHash();
}

$('run-close').addEventListener('click', () => {
  closeRun();
  render();
});

$('run-video-full').addEventListener('click', openVideoModal);
$('run-video-open').addEventListener('click', openVideoModal);

async function startUnsaved(run) {
  try {
    const data = await api('POST', '/api/runs', { url: run.url, scenario: run.scenario, maxSteps: Number($('max-steps').value) });
    await refresh();
    openRun(data.id);
  } catch (err) {
    alert(err.message);
  }
}

// --- Settings ---

const STEPS_KEY = 'probei.maxSteps';
try {
  const saved = localStorage.getItem(STEPS_KEY);
  if (saved) $('max-steps').value = saved;
} catch {
  // Keep the default.
}
$('max-steps').addEventListener('change', () => {
  try {
    localStorage.setItem(STEPS_KEY, $('max-steps').value);
  } catch {
    // Non-persistent is fine.
  }
});

// --- Theme: auto (follows the OS), light, dark ---

const THEME_KEY = 'probei.theme';
const THEMES = ['auto', 'light', 'dark'];

function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('theme-btn').textContent = theme;
  $('theme-btn').title = `Color theme: ${theme} (click to switch)`;
}

let theme = 'auto';
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (THEMES.includes(saved)) theme = saved;
} catch {
  // Auto is fine.
}
applyTheme(theme);
$('theme-btn').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Non-persistent is fine.
  }
});

// --- Voice input: the browser's own speech recognition, English only for the MVP, no model tokens ---

function setupVoiceInput() {
  const btn = $('mic');
  const status = $('mic-status');
  const field = $('sc-text');
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) {
    btn.hidden = true;
    return;
  }
  const rec = new Rec();
  rec.lang = 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  let base = '';
  let listening = false;

  const setUI = (on, msg) => {
    listening = on;
    btn.classList.toggle('recording', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Stop voice input' : 'Describe the scenario by voice (English)';
    status.textContent = msg || '';
  };

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) base = base ? `${base} ${r[0].transcript.trim()}` : r[0].transcript.trim();
      else interim += r[0].transcript;
    }
    field.value = interim ? `${base}${base ? ' ' : ''}${interim}` : base;
  };
  rec.onerror = (e) => {
    if (e.error === 'aborted') {
      setUI(false, '');
      return;
    }
    const msg =
      e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Microphone blocked — allow access and try again.'
        : e.error === 'no-speech'
          ? 'No speech heard — try again.'
          : `Voice input failed (${e.error}).`;
    field.value = base;
    setUI(false, msg);
  };
  rec.onend = () => {
    if (listening) setUI(false, '');
  };

  btn.addEventListener('click', () => {
    if (listening) {
      field.value = base;
      rec.stop();
      setUI(false, '');
      return;
    }
    base = field.value.trim();
    try {
      rec.start();
      setUI(true, 'Listening (English)… click the mic to stop.');
    } catch {
      setUI(false, 'Voice input is already running.');
    }
  });
}

setupVoiceInput();

// --- Start ---

const initial = readHash();
state.view = initial.project;
await refresh();
if (initial.run && state.runs.some((r) => r.id === initial.run)) openRun(initial.run);
else {
  const latest = latestRun(currentProject());
  if (latest) openRun(latest.id);
}
