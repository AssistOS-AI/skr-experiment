import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINES, buildRunnerInput, runEvaluation } from '../src/evaluation/index.mjs';
import { readFile } from 'node:fs/promises';

test('runner payload is an allow-list and does not contain gold', async () => {
  const data = JSON.parse(await readFile(new URL('../fixtures/controlled.json', import.meta.url), 'utf8'));
  const payload = buildRunnerInput(data.cases[0], 'skr-full');
  assert.equal(JSON.stringify(payload).includes('gold'), false);
  assert.equal(payload.snapshot.id, 'fixture_direct-1');
});

test('live retrieval baselines are declared as implemented adapters, separately from controlled references', () => {
  for (const name of ['hybrid-rag','agentic-rag','graphrag','full-source-agent']) assert.equal(BASELINES[name].status,'live-adapter');
});

test('frozen controlled evaluation records family metrics, costs and hash', async () => {
  const out = await runEvaluation({baselines:['skr-direct','skr-full','hybrid-rag']});
  assert.equal(out.caseCount,9);
  assert.equal(out.status,'passed');
  assert.match(out.fixtureSha256,/^[a-f0-9]{64}$/);
  const full = out.results.find(x => x.baseline === 'skr-full' && x.aggregate);
  assert.ok(full.metricsByFamily['relational-retrieval']);
  assert.equal(full.cost.modelCost,null);
  const fullCases = out.results.filter(x => x.baseline === 'skr-full' && x.caseId);
  assert.equal(fullCases.length,9);
  assert.ok(fullCases.every(x => x.answerCorrect === 1));
  assert.ok(fullCases.every(x => x.bindingCorrect !== 0));
  assert.ok(fullCases.every(x => x.auditStatus === 'valid'));
  assert.equal(out.results.find(x => x.baseline === 'skr-direct' && x.caseId === 'three-hop-1').predicted,'unresolved');
  assert.equal(out.results.find(x => x.baseline === 'hybrid-rag').status,'live-adapter');
});
