import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchFingerprint, fingerprintResponse, hashBody, isNewDeploy } from '../src/deploy.js';
import { createProject, parseStore } from '../src/projects.js';

describe('deploy fingerprints', () => {
  it('prefers ETag, then Last-Modified, then body hash', () => {
    assert.equal(fingerprintResponse({ etag: '"v2"', lastModified: 'today', body: 'a' }), 'etag:"v2"');
    assert.equal(fingerprintResponse({ lastModified: 'today', body: 'a' }), 'lm:today');
    assert.equal(fingerprintResponse({ body: 'a' }), `body:${hashBody('a')}`);
    assert.notEqual(hashBody('a'), hashBody('b'));
  });

  it('detects a deploy only when both fingerprints exist and differ', () => {
    assert.equal(isNewDeploy('body:aaa', 'body:bbb'), true);
    assert.equal(isNewDeploy('body:aaa', 'body:aaa'), false);
    assert.equal(isNewDeploy(null, 'body:bbb'), false);
    assert.equal(isNewDeploy('body:aaa', null), false);
    assert.equal(isNewDeploy(undefined, undefined), false);
  });

  it('fetches a fingerprint and notices a body change, null when unreachable', async () => {
    let body = '<html>v1</html>';
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/`;
      const first = await fetchFingerprint(url);
      assert.ok(first?.startsWith('body:'));
      assert.equal(isNewDeploy(first, first), false);
      body = '<html>v2</html>';
      const second = await fetchFingerprint(url);
      assert.equal(isNewDeploy(first, second), true);
    } finally {
      server.close();
    }
    assert.equal(await fetchFingerprint('http://127.0.0.1:1/', 200), null);
  });
});

describe('deploy watch project fields', () => {
  it('defaults to unwatched with no fingerprint', () => {
    const project = createProject({ url: 'https://a.example/' });
    assert.equal(project.notifyOnDeploy, false);
    assert.equal(project.autoRunOnDeploy, false);
    assert.equal(project.deployFingerprint, null);
  });

  it('parses watch fields tolerantly', () => {
    const store = parseStore({
      projects: [
        { id: 'p1', url: 'https://a.example/', notifyOnDeploy: true, autoRunOnDeploy: true, deployFingerprint: 'etag:"1"', lastDeployCheckAt: '2026-10-29T00:00:00.000Z', lastDeployAt: '2026-10-29T01:00:00.000Z' },
        { id: 'p2', url: 'https://b.example/', notifyOnDeploy: 'yes', autoRunOnDeploy: 'yes', deployFingerprint: 42 },
        { id: 'p3', url: 'https://c.example/' }, // old projects without the flags stay unwatched
      ],
    });
    assert.equal(store.projects[0].notifyOnDeploy, true);
    assert.equal(store.projects[0].autoRunOnDeploy, true);
    assert.equal(store.projects[0].deployFingerprint, 'etag:"1"');
    assert.equal(store.projects[0].lastDeployAt, '2026-10-29T01:00:00.000Z');
    assert.equal(store.projects[1].notifyOnDeploy, false);
    assert.equal(store.projects[1].autoRunOnDeploy, false);
    assert.equal(store.projects[1].deployFingerprint, null);
    assert.equal(store.projects[2].notifyOnDeploy, false);
    assert.equal(store.projects[2].autoRunOnDeploy, false);
  });
});
