import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGroundTruth, scoreCase, summarize, type BenchCase } from '../src/bench.js';
import type { RunResult } from '../src/agent.js';

const result = (over: Partial<RunResult>): RunResult =>
  ({
    status: 'passed',
    url: 'https://a.example/',
    scenario: 'x',
    provider: 'baseten',
    model: 'm',
    steps: [],
    usage: { promptTokens: 10, completionTokens: 5 },
    startedAt: new Date(0).toISOString(),
    durationMs: 1000,
    ...over,
  }) as RunResult;

describe('parseGroundTruth', () => {
  it('reads { scenarios: [...] } with per-item expectations', () => {
    const cases = parseGroundTruth(
      {
        scenarios: [
          { id: 'b1', url: 'https://a.example/', scenario: 'Buy tea', expect: 'bug' },
          { scenario: 'Look around', expected: 'pass' },
        ],
      },
      'https://default.example/',
    );
    assert.deepEqual(
      cases.map((c) => [c.id, c.expect, c.url]),
      [
        ['b1', 'bug', 'https://a.example/'],
        ['case-2', 'pass', 'https://default.example/'],
      ],
    );
  });

  it('reads { bugs, clean } splits and bare arrays', () => {
    const split = parseGroundTruth({ bugs: [{ text: 'Broken' }], clean: [{ steps: 'Fine' }] }, 'https://d.example/');
    assert.deepEqual(
      split.map((c) => [c.id, c.expect, c.scenario]),
      [
        ['bug-1', 'bug', 'Broken'],
        ['clean-1', 'pass', 'Fine'],
      ],
    );
    const bare = parseGroundTruth([{ scenario: 'X', expect: 'fail' }], 'https://d.example/');
    assert.deepEqual(
      bare.map((c) => [c.id, c.expect]),
      [['case-1', 'bug']],
    );
  });

  it('reads the zoo shape { apps: { name: { url, bugs, clean_scenarios } } }', () => {
    const cases = parseGroundTruth(
      {
        apps: {
          shop: {
            url: 'https://shop.example/',
            bugs: [{ id: 'b1', scenario: 'Broken checkout' }],
            clean_scenarios: ['Browse the catalog'],
          },
        },
      },
      'https://default.example/',
    );
    assert.deepEqual(
      cases.map((c) => [c.id, c.expect, c.url, c.scenario]),
      [
        ['b1', 'bug', 'https://shop.example/', 'Broken checkout'],
        ['shop-clean-1', 'pass', 'https://shop.example/', 'Browse the catalog'],
      ],
    );
  });

  it('drops blank and expectation-less entries instead of throwing', () => {
    assert.deepEqual(parseGroundTruth(null, 'https://d.example/'), []);
    assert.deepEqual(parseGroundTruth({ scenarios: [{ scenario: '   ', expect: 'bug' }, { scenario: 'No expect' }, 42] }, 'https://d.example/'), []);
  });
});

describe('scoreCase', () => {
  const bugCase: BenchCase = { id: 'b', url: 'https://a.example/', scenario: 'x', expect: 'bug' };
  const cleanCase: BenchCase = { id: 'c', url: 'https://a.example/', scenario: 'x', expect: 'pass' };

  it('counts found bugs and passed clean scenarios only', () => {
    assert.equal(scoreCase(bugCase, result({ status: 'bug', bug: { type: 'bug', title: 'T', severity: 'major', expected: '', actual: '', summary: '' } })).ok, true);
    assert.equal(scoreCase(bugCase, result({ status: 'passed' })).ok, false);
    assert.equal(scoreCase(bugCase, result({ status: 'stuck' })).ok, false);
    assert.equal(scoreCase(cleanCase, result({ status: 'passed' })).ok, true);
    assert.equal(scoreCase(cleanCase, result({ status: 'bug' })).ok, false);
  });
});

describe('summarize', () => {
  it('tallies finds, false alarms and token totals', () => {
    const s = summarize([
      { id: 'b1', expect: 'bug', status: 'bug', ok: true, steps: 3, durationMs: 1000, promptTokens: 10, completionTokens: 5, bugTitle: 'T' },
      { id: 'b2', expect: 'bug', status: 'passed', ok: false, steps: 2, durationMs: 500, promptTokens: 6, completionTokens: 2, bugTitle: null },
      { id: 'c1', expect: 'pass', status: 'bug', ok: false, steps: 4, durationMs: 800, promptTokens: 8, completionTokens: 3, bugTitle: 'False' },
      { id: 'c2', expect: 'pass', status: 'passed', ok: true, steps: 1, durationMs: 200, promptTokens: 4, completionTokens: 1, bugTitle: null },
    ]);
    assert.deepEqual(s, {
      cases: 4,
      bugsFound: 1,
      bugsTotal: 2,
      cleanPassed: 1,
      cleanTotal: 2,
      falseAlarms: 1,
      steps: 10,
      durationMs: 2500,
      promptTokens: 28,
      completionTokens: 11,
    });
  });
});
