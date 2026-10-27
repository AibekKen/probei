'use strict';
/* Probei run page: start runs, stream live steps over SSE, browse past reports. */
const $ = (id) => document.getElementById(id);
let source = null;

function closeStream() {
  if (source) {
    source.close();
    source = null;
  }
}

function showFormError(msg) {
  const el = $('form-error');
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

async function refreshHistory() {
  const box = $('history');
  try {
    const res = await fetch('/api/runs');
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const runs = await res.json();
    box.innerHTML = '';
    if (!runs.length) {
      box.innerHTML = '<p class="msg">No runs yet.</p>';
      return;
    }
    for (const r of runs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-item';
      const top = document.createElement('div');
      top.className = 'history-top';
      const id = document.createElement('code');
      id.textContent = r.id;
      const st = document.createElement('span');
      st.className = `badge ${r.status}`;
      st.textContent = r.status;
      top.append(id, st);
      const sc = document.createElement('div');
      sc.className = 'history-scenario';
      sc.textContent = r.scenario;
      btn.append(top, sc);
      btn.addEventListener('click', () => watchRun(r.id));
      box.append(btn);
    }
  } catch (err) {
    box.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'msg error';
    p.textContent = `Could not load runs: ${err.message}`;
    box.append(p);
  }
}

function appendStep(runId, step) {
  const box = $('steps');
  const div = document.createElement('div');
  div.className = 'step';
  const head = document.createElement('div');
  head.className = 'step-head';
  const n = document.createElement('strong');
  n.textContent = `Step ${step.n}`;
  head.append(n);
  if (step.note) {
    const note = document.createElement('span');
    note.className = 'msg';
    note.textContent = step.note;
    head.append(note);
  }
  div.append(head);
  if (step.thought) {
    const t = document.createElement('p');
    t.textContent = step.thought;
    div.append(t);
  }
  if (step.action) {
    const code = document.createElement('code');
    code.className = 'action';
    code.textContent = JSON.stringify(step.action);
    div.append(code);
  }
  for (const e of step.errors ?? []) {
    const p = document.createElement('p');
    p.className = 'msg error';
    p.textContent = e;
    div.append(p);
  }
  if (step.screenshot) {
    const img = document.createElement('img');
    img.src = `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(step.screenshot)}`;
    img.alt = `screenshot of step ${step.n}`;
    img.loading = 'lazy';
    div.append(img);
  }
  box.append(div);
  div.scrollIntoView({ block: 'nearest' });
}

function setStatus(status) {
  const el = $('run-status');
  el.className = `badge ${status}`;
  el.textContent = status;
}

function showSummary(runId, done) {
  const box = $('run-summary');
  box.hidden = false;
  box.innerHTML = '';
  if (done.bug) {
    const h = document.createElement('h3');
    h.textContent = `Bug: ${done.bug.title} (${done.bug.severity})`;
    const exp = document.createElement('p');
    exp.textContent = `Expected: ${done.bug.expected}`;
    const act = document.createElement('p');
    act.textContent = `Actual: ${done.bug.actual}`;
    box.append(h, exp, act);
  }
  if (done.summary) {
    const p = document.createElement('p');
    p.textContent = done.summary;
    box.append(p);
  }
  if (done.error) {
    const p = document.createElement('p');
    p.className = 'msg error';
    p.textContent = done.error;
    box.append(p);
  }
  if (done.video) {
    $('run-video-p').hidden = false;
    $('run-video').href = `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(done.video)}`;
  }
}

function watchRun(id) {
  closeStream();
  $('run-section').hidden = false;
  $('run-id').textContent = id;
  $('steps').innerHTML = '';
  $('run-summary').hidden = true;
  $('run-summary').innerHTML = '';
  $('run-video-p').hidden = true;
  setStatus('running');
  source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  source.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.type === 'step') appendStep(id, ev.step);
    else if (ev.type === 'done') {
      setStatus(ev.status);
      showSummary(id, ev);
      closeStream();
      $('start').disabled = false;
      void refreshHistory();
    }
  };
  source.onerror = () => {
    setStatus('error');
    showSummary(id, { error: 'Lost connection to the server.' });
    closeStream();
    $('start').disabled = false;
  };
}

$('run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showFormError(null);
  $('start').disabled = true;
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: $('url').value.trim(),
        scenario: $('scenario').value.trim(),
        maxSteps: Number($('max-steps').value),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
    watchRun(data.id);
  } catch (err) {
    showFormError(err.message);
    $('start').disabled = false;
  }
});

$('refresh').addEventListener('click', () => void refreshHistory());
void refreshHistory();
