/* Probei workspace: projects (app URLs) → saved scenarios → each scenario's runs.
 * Runs stream live over SSE into the right-hand run pane. */
import { assignRuns, groupByScenario, hostOf, isHttpUrl, projectForUrl, projectStatus } from './lib.js';

const $ = (id) => document.getElementById(id);

const state = {
  projects: [],
  runs: [],
  byScenario: new Map(),
  unassigned: [],
  /** project id, 'unassigned', or null */
  view: null,
  runId: null,
  /** scenario ids whose full history is expanded */
  expanded: new Set(),
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
  return el('span', { class: `badge ${status}`, text: STATUS_TEXT[status] ?? status });
}

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
  }
  render();
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
  for (const s of project.scenarios) list.append(scenarioCard(project, s));
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

function scenarioCard(project, s) {
  const runs = state.byScenario.get(s.id) ?? [];
  const last = runs[0];
  const head = el(
    'div',
    { class: 'scenario-head' },
    el(
      'div',
      { class: 'scenario-title' },
      el('strong', { text: s.title }),
      s.source === 'auto' ? el('span', { class: 'tag', text: 'auto', title: 'Drafted by auto-review' }) : null,
      last ? badge(last.status) : el('span', { class: 'badge', text: 'not run' }),
    ),
    el(
      'div',
      { class: 'actions' },
      el('button', {
        type: 'button',
        class: 'small',
        text: last?.status === 'running' ? 'Running…' : last?.status === 'queued' ? 'Queued' : runs.length ? 'Run again' : 'Run',
        disabled: scenarioPending(s.id),
        onclick: () => void startRun(project, s),
      }),
      button('Edit', () => openScenarioForm(s)),
      button('Delete', () => void deleteScenario(project, s), 'danger small'),
    ),
  );
  const text = el('div', { class: 'scenario-text', text: s.text, title: 'Click to expand' });
  text.addEventListener('click', () => text.classList.toggle('open'));
  const card = el('article', { class: 'scenario' }, head, text);
  if (s.url !== project.url) card.append(el('div', { class: 'scenario-meta', text: `Starts at ${s.url}` }));

  if (runs.length) {
    const showAll = state.expanded.has(s.id);
    const shown = showAll ? runs : runs.slice(0, 3);
    const hist = el('div', { class: 'runs' });
    for (const r of shown) hist.append(runRow(r));
    if (runs.length > 3) {
      hist.append(
        button(showAll ? 'Show fewer' : `Show all ${runs.length} runs`, () => {
          if (showAll) state.expanded.delete(s.id);
          else state.expanded.add(s.id);
          render();
        }, 'link small'),
      );
    }
    card.append(hist);
  }
  return card;
}

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
  $('review-status').textContent = 'Reviewing the app: walking its pages and drafting scenarios… this takes a minute or two.';
  $('review-status').classList.add('working');
  render();
  try {
    const data = await api('POST', `/api/projects/${project.id}/review`);
    $('review-status').textContent = data.added.length
      ? `Reviewed ${data.pagesReviewed} page(s): added ${data.added.length} scenario(s).`
      : `Reviewed ${data.pagesReviewed} page(s): no new scenarios (all ${data.drafted} drafts were already saved).`;
  } catch (err) {
    $('review-status').textContent = '';
    showError('project-error', `Auto-review failed: ${err.message}`);
  } finally {
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
  const div = el('div', { class: 'step' });
  const head = el('div', { class: 'step-head' }, el('strong', { text: `Step ${step.n}` }));
  if (step.note) head.append(el('span', { class: 'msg', text: step.note }));
  div.append(head);
  if (step.thought) div.append(el('p', { text: step.thought }));
  if (step.action) div.append(el('code', { class: 'action', text: describeAction(step.action), title: JSON.stringify(step.action) }));
  for (const e of step.errors ?? []) div.append(el('p', { class: 'msg error', text: e }));
  if (step.screenshot) {
    div.append(
      el('img', {
        src: `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(step.screenshot)}`,
        alt: `screenshot of step ${step.n}`,
        loading: 'lazy',
      }),
    );
  }
  $('steps').append(div);
  if (state.live) div.scrollIntoView({ block: 'nearest' });
}

function setRunStatus(status) {
  const b = $('run-status');
  b.className = `badge ${status}`;
  b.textContent = STATUS_TEXT[status] ?? status;
}

function showSummary(runId, done) {
  const box = $('run-summary');
  box.hidden = false;
  box.innerHTML = '';
  if (done.bug) {
    box.append(
      el('h3', { text: `Bug: ${done.bug.title} (${done.bug.severity})` }),
      el('p', { text: `Expected: ${done.bug.expected}` }),
      el('p', { text: `Actual: ${done.bug.actual}` }),
    );
  }
  if (done.summary) box.append(el('p', { text: done.summary }));
  if (done.error) box.append(el('p', { class: 'msg error', text: done.error }));
  if (!box.childNodes.length) box.hidden = true;
  if (done.video) {
    const url = `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(done.video)}`;
    $('run-video-p').hidden = false;
    $('run-video').src = url;
    $('run-video-link').href = url;
  }
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
  $('run-empty').hidden = true;
  $('run-view').hidden = false;
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
  $('run-summary').hidden = true;
  $('run-summary').innerHTML = '';
  $('run-video-p').hidden = true;
  $('run-video').removeAttribute('src');
  setRunStatus(run && PENDING.has(run.status) ? run.status : '…');
  state.live = Boolean(run && PENDING.has(run.status));
  render();
  if (matchMedia('(max-width: 1100px)').matches) $('run-pane').scrollIntoView({ behavior: 'smooth', block: 'start' });

  source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  source.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.type === 'queued') setRunStatus('queued');
    else if (ev.type === 'started') setRunStatus('running');
    else if (ev.type === 'step') {
      setRunStatus('running');
      appendStep(id, ev.step);
    } else if (ev.type === 'done') {
      setRunStatus(ev.status);
      showSummary(id, ev);
      closeStream();
      if (state.live) {
        state.live = false;
        void refresh();
      }
    }
  };
  source.onerror = () => {
    setRunStatus('error');
    showSummary(id, { error: 'Lost connection to the server.' });
    closeStream();
  };
}

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
