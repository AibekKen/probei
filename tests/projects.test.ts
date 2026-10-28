import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addScenarios, createProject, httpUrl, parseStore, ProjectStore } from '../src/projects.js';

describe('projects', () => {
  it('names a project after its URL when no name is given', () => {
    assert.equal(createProject({ url: 'http://localhost:5173/shop/' }).name, 'localhost:5173/shop');
    assert.equal(createProject({ name: ' Shop ', url: 'https://a.example/' }).name, 'Shop');
  });

  it('adds scenarios once, defaulting title and url', () => {
    const project = createProject({ url: 'https://a.example/' });
    const added = addScenarios(
      project,
      [
        { text: 'Buy tea\nExpected: total 2500' },
        { text: '  Buy tea   Expected: total 2500 ' },
        { text: '   ' },
        { title: 'Cart', text: 'Open cart', url: 'https://a.example/cart' },
      ],
      'auto',
    );
    assert.deepEqual(added.map((s) => s.title), ['Buy tea', 'Cart']);
    assert.equal(added[0].url, 'https://a.example/');
    assert.equal(added[1].url, 'https://a.example/cart');
    assert.equal(added[0].source, 'auto');
    assert.equal(addScenarios(project, [{ text: 'Open cart' }], 'manual').length, 0);
  });

  it('parses stored data tolerantly', () => {
    assert.deepEqual(parseStore(null), { projects: [] });
    const store = parseStore({
      projects: [
        { id: 'p1', url: 'ftp://x/' },
        { id: 'p2', url: 'https://a.example/', scenarios: [{ id: 's', text: 'Do it', url: 'bad' }, { id: 'e', text: ' ' }] },
      ],
    });
    assert.equal(store.projects.length, 1);
    assert.equal(store.projects[0].scenarios.length, 1);
    assert.equal(store.projects[0].scenarios[0].url, 'https://a.example/');
    assert.equal(httpUrl('javascript:alert(1)'), null);
  });

  it('serializes concurrent updates to the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'probei-'));
    try {
      const store = new ProjectStore(join(dir, 'projects.json'));
      await Promise.all(
        ['https://a.example/', 'https://b.example/', 'https://c.example/'].map((url) =>
          store.update((s) => s.projects.push(createProject({ url }))),
        ),
      );
      const saved = JSON.parse(await readFile(join(dir, 'projects.json'), 'utf8'));
      assert.equal(saved.projects.length, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
