import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignRuns,
  groupByScenario,
  isHttpUrl,
  isNewScenario,
  outcomeOf,
  projectForUrl,
  projectStatus,
  runMatches,
  splitScenario,
  summarize,
} from '../web/lib.js';

const shop = {
  id: 'p1',
  name: 'Shop',
  url: 'https://shop.example.com/',
  scenarios: [
    { id: 's1', title: 'Buy tea', text: 'Buy tea\nExpected: total ok', url: 'https://shop.example.com/', source: 'manual' },
    { id: 's2', title: 'Open cart', text: 'Open cart', url: 'https://shop.example.com/cart', source: 'auto' },
  ],
};

const run = (over: Record<string, unknown>) => ({
  id: 'r',
  projectId: null,
  scenarioId: null,
  status: 'passed',
  url: 'https://shop.example.com/',
  scenario: 'x',
  startedAt: '2026-10-28T10:00:00.000Z',
  steps: 1,
  bugTitle: null,
  ...over,
});

describe('runMatches', () => {
  it('matches linked runs by scenario id only', () => {
    assert.equal(runMatches(run({ scenarioId: 's1', scenario: 'other' }), shop.scenarios[0]), true);
    assert.equal(runMatches(run({ scenarioId: 's2', scenario: 'Buy tea Expected: total ok' }), shop.scenarios[0]), false);
  });

  it('matches older unlinked runs by url and whitespace-normalized text', () => {
    assert.equal(runMatches(run({ scenario: '  Buy tea   Expected: total ok ' }), shop.scenarios[0]), true);
    assert.equal(runMatches(run({ scenario: 'Buy tea Expected: total ok', url: 'https://other.example/' }), shop.scenarios[0]), false);
  });
});

describe('assignRuns', () => {
  it('puts runs under their scenario newest first, the rest in unassigned', () => {
    const runs = [
      run({ id: 'a', scenarioId: 's1', startedAt: '2026-10-27T10:00:00.000Z' }),
      run({ id: 'b', scenarioId: 's1', startedAt: '2026-10-28T10:00:00.000Z', status: 'bug' }),
      run({ id: 'c', scenario: 'Open cart', url: 'https://shop.example.com/cart', startedAt: '2026-10-20T10:00:00.000Z' }),
      run({ id: 'd', scenario: 'Something else' }),
    ];
    const { byScenario, unassigned } = assignRuns(runs, [shop]);
    assert.deepEqual(byScenario.get('s1')!.map((r) => r.id), ['b', 'a']);
    assert.deepEqual(byScenario.get('s2')!.map((r) => r.id), ['c']);
    assert.deepEqual(unassigned.map((r) => r.id), ['d']);
    assert.equal(projectStatus(shop, byScenario), 'bug');
  });

  it('reports running before anything else', () => {
    const { byScenario } = assignRuns(
      [run({ id: 'a', scenarioId: 's2', status: 'running', startedAt: '2026-10-01T00:00:00.000Z' }), run({ id: 'b', scenarioId: 's1' })],
      [shop],
    );
    assert.equal(projectStatus(shop, byScenario), 'running');
    assert.equal(projectStatus({ ...shop, scenarios: [] }, byScenario), null);
  });
});

describe('groupByScenario', () => {
  it('groups by url + normalized text, newest group first', () => {
    const groups = groupByScenario([
      run({ id: 'a', scenario: 'Buy  tea', startedAt: '2026-10-27T10:00:00.000Z' }),
      run({ id: 'b', scenario: 'Read post', url: 'https://blog.example.org/', startedAt: '2026-10-26T10:00:00.000Z' }),
      run({ id: 'c', scenario: 'Buy tea', startedAt: '2026-10-28T10:00:00.000Z' }),
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].items.map((r) => r.id), ['c', 'a']);
    assert.equal(groups[0].url, 'https://shop.example.com/');
  });
});

describe('url helpers', () => {
  it('accepts only http(s) and finds the project by origin', () => {
    assert.equal(isHttpUrl('https://a.example/'), true);
    assert.equal(isHttpUrl('ftp://a.example/'), false);
    assert.equal(projectForUrl([shop], 'https://shop.example.com/checkout')?.id, 'p1');
    assert.equal(projectForUrl([shop], 'https://blog.example.org/'), null);
    assert.equal(projectForUrl([shop], 'nope'), null);
  });
});

describe('projectStatus with a queue', () => {
  it('shows queued when runs wait and none is running', () => {
    const { byScenario } = assignRuns(
      [run({ id: 'a', scenarioId: 's1', status: 'queued', startedAt: '2026-10-29T00:00:00.000Z' }), run({ id: 'b', scenarioId: 's2', status: 'bug' })],
      [shop],
    );
    assert.equal(projectStatus(shop, byScenario), 'queued');
  });
});

describe('outcomes', () => {
  it('separates app bugs from runs the agent did not finish', () => {
    assert.equal(outcomeOf(undefined), 'not_run');
    assert.equal(outcomeOf(run({ status: 'bug' })), 'bug');
    assert.equal(outcomeOf(run({ status: 'stuck' })), 'incomplete');
    assert.equal(outcomeOf(run({ status: 'max_steps' })), 'incomplete');
    assert.equal(outcomeOf(run({ status: 'error' })), 'incomplete');
    assert.equal(outcomeOf(run({ status: 'queued' })), 'pending');
  });

  it('counts each scenario by its latest run', () => {
    const { byScenario } = assignRuns(
      [
        run({ id: 'a', scenarioId: 's1', status: 'bug', startedAt: '2026-10-27T00:00:00.000Z' }),
        run({ id: 'b', scenarioId: 's1', status: 'passed', startedAt: '2026-10-28T00:00:00.000Z' }),
      ],
      [shop],
    );
    assert.deepEqual(summarize(shop, byScenario), { total: 2, passed: 1, bug: 0, incomplete: 0, not_run: 1, pending: 0 });
  });
});

describe('splitScenario', () => {
  it('drops the leading open-the-start-url step and splits off Expected', () => {
    const parts = splitScenario('Open http://localhost:5173/shop/. Click Add to cart. Expected: Cart: 1.', 'http://localhost:5173/shop/');
    assert.deepEqual(parts, { steps: 'Click Add to cart.', expected: 'Cart: 1.' });
  });

  it('keeps an open step for another url and handles no Expected', () => {
    assert.deepEqual(splitScenario('Open https://other.example/ and look', 'http://localhost:5173/shop/'), {
      steps: 'Open https://other.example/ and look',
      expected: '',
    });
  });
});

describe('isNewScenario', () => {
  const project = { ...shop, lastReview: { at: '2026-10-29T00:01:00.000Z', pages: 1, added: 1 } };
  it('tags auto scenarios from the latest review until they run', () => {
    const fresh = { ...shop.scenarios[1], createdAt: '2026-10-29T00:00:59.000Z' };
    assert.equal(isNewScenario(fresh, project, []), true);
    assert.equal(isNewScenario(fresh, project, [run({})]), false);
    assert.equal(isNewScenario({ ...fresh, createdAt: '2026-10-28T00:00:00.000Z' }, project, []), false);
    assert.equal(isNewScenario({ ...fresh, source: 'manual' }, project, []), false);
  });
});
