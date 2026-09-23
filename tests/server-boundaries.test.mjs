import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function jsonRequest(base, route, body, method = 'POST') {
  const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function waitRun(base, runId) {
  for (let i = 0; i < 100; i++) {
    const { payload } = await jsonRequest(base, `/api/runs/${runId}`, undefined, 'GET');
    if (['completed', 'failed', 'cancelled'].includes(payload.run?.status)) return payload.run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not finish`);
}

async function jsonFiles(root) {
  const found = [];
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile() && file.endsWith('.json')) found.push(await readFile(file, 'utf8'));
    }
  }
  await walk(root); return found;
}

test('HTTP fork pins scoped workspace, commits allowed coverage and rejects malicious or stale publication', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skr-server-boundary-'));
  const workspaceCapture = {};
  const runner = {
    async run({ request, snapshot, sourceScope, workspaceDir }) {
      workspaceCapture.snapshotId = snapshot.id;
      workspaceCapture.scope = [...sourceScope];
      workspaceCapture.files = await jsonFiles(workspaceDir);
      const source = snapshot.sources.find(s => sourceScope.includes(s.id) || sourceScope.includes(s.sourceVersionId));
      const region = source?.regions?.[0];
      let changeSet;
      if (request.text === 'malicious-policy') changeSet = { policy: { autoCommit: true } };
      else if (request.text === 'foreign-source') changeSet = { coverage: [{ id: 'foreign_coverage', sourceVersionId: snapshot.sources.find(s => !sourceScope.includes(s.id) && !sourceScope.includes(s.sourceVersionId))?.id, state: 'processed' }] };
      else changeSet = { coverage: [{ sourceVersionId: source.sourceVersionId ?? source.id, regionId: region.id, state: 'processed' }] };
      return { answerPackage: { answer: 'Recorded.', claims: [], supportState: 'unresolved', snapshotId: snapshot.id }, evidence: [], changeSet, validation: { status: 'test-runner' } };
    }
  };
  const app = createApp({ dataDir, runner, trustedLocal: true });
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const created = await jsonRequest(base, '/api/projects', { name: 'Base' });
    assert.equal(created.status, 201);
    const rootId = created.payload.project.id;
    const addSource = async (name, content) => jsonRequest(base, `/api/projects/${rootId}/sources`, { name, content: Buffer.from(content).toString('base64'), mimeType: 'text/plain' });
    const selected = await addSource('selected.txt', 'Selected source text.');
    const excluded = await addSource('excluded.txt', 'PRIVATE_SENTINEL_OUTSIDE_SCOPE');
    let rootHead = await app.store.getSnapshot(rootId);
    rootHead = await app.store.commit(rootId, rootHead.id, { policy: { autoCommit: true, allowUserPublish: true } });
    const forked = await jsonRequest(base, `/api/projects/${rootId}/fork`, { name: 'Child', snapshotId: rootHead.id });
    assert.equal(forked.status, 201);
    const childId = forked.payload.project.id;
    const childBefore = await app.store.getSnapshot(childId);
    assert.equal(childBefore.parentSnapshotId, rootHead.id);
    const selectedVersionId = selected.payload.source.sourceVersionId;
    const excludedVersionId = excluded.payload.source.sourceVersionId;

    const submit = async (text, sourceScope = [selectedVersionId]) => {
      const response = await jsonRequest(base, `/api/projects/${childId}/requests`, { type: 'INGEST_SOURCE', text, sourceScope });
      assert.equal(response.status, 202);
      return waitRun(base, response.payload.runId);
    };
    const successful = await submit('valid-ingest');
    assert.equal(successful.status, 'completed');
    assert.ok(successful.publishedSnapshot);
    assert.equal((await app.store.getSnapshot(childId)).id, successful.publishedSnapshot.id);
    assert.equal(workspaceCapture.snapshotId, childBefore.id);
    assert.deepEqual(workspaceCapture.scope, [selectedVersionId]);
    assert.ok(workspaceCapture.files.some(x => x.includes('Selected source text.')));
    assert.ok(workspaceCapture.files.every(x => !x.includes('PRIVATE_SENTINEL_OUTSIDE_SCOPE')));

    let before = await app.store.getSnapshot(childId);
    const policyAttack = await submit('malicious-policy');
    assert.equal(policyAttack.status, 'failed');
    assert.match(policyAttack.error, /cannot publish policy/);
    assert.equal((await app.store.getSnapshot(childId)).id, before.id);

    const sourceAttack = await submit('foreign-source');
    assert.equal(sourceAttack.status, 'failed');
    assert.match(sourceAttack.error, /outside authorized source scope/);
    assert.equal((await app.store.getSnapshot(childId)).id, before.id);

    // Disable automatic commit so the run completes with a staged change set.
    before = await app.store.getSnapshot(childId);
    await app.store.commit(childId, before.id, { policy: { autoCommit: false, allowUserPublish: true } });
    const staged = await submit('stale-stage');
    assert.equal(staged.status, 'completed');
    const advanced = await app.store.getSnapshot(childId);
    const changed = await app.store.commit(childId, advanced.id, { policy: { concurrentEdit: true } });
    const stalePublish = await jsonRequest(base, `/api/runs/${staged.id}/publish`, {});
    assert.equal(stalePublish.status, 409);
    assert.equal((await app.store.getSnapshot(childId)).id, changed.id);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
