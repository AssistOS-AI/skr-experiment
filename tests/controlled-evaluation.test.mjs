import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateControlledCases } from '../src/evaluation/controlled-generator.mjs';
import { runEvaluation } from '../src/evaluation/index.mjs';

test('controlled generator contains distinct structural and scope families',async()=>{
  const cases=generateControlledCases();
  assert.equal(cases.length,346);assert.equal(new Set(cases.map(c=>c.id)).size,346);
  assert.deepEqual(Object.fromEntries([...new Set(cases.map(c=>c.family))].map(f=>[f,cases.filter(c=>c.family===f).length])),{
    'exact-qualified-assertions':30,'multi-premise-joins':64,'complete-multi-tuple-enumeration':24,'bounded-multihop-graphs':60,
    'aligned-and-misaligned-qualifiers':48,'same-scope-opposition':10,'temporal-revision-not-contradiction':10,'incomplete-join-evidence':36,
    'rule-exception-counterevidence':32,'lifecycle-scope-and-role-robustness':32
  });
  const paths=cases.filter(c=>c.family==='bounded-multihop-graphs');assert.ok(new Set(paths.map(c=>c.records.length)).size>3);
  assert.ok(paths.some(c=>c.records.some(r=>r.id.startsWith('shortcut_'))));
});

test('frozen controlled evaluation scores full binding tuples and direct-only misses real rule paths',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../fixtures/controlled-v2.json',import.meta.url),'utf8'));
  assert.equal(fixture.caseCount,346);assert.equal(fixture.frozen,true);
  const report=await runEvaluation({fixturePath:new URL('../fixtures/controlled-v2.json',import.meta.url).pathname,baselines:['skr-direct','skr-full']});
  assert.equal(report.status,'passed');assert.equal(report.caseCount,346);assert.deepEqual(report.acceptanceFailures,[]);
  const full=report.results.find(x=>x.baseline==='skr-full'&&x.aggregate),direct=report.results.find(x=>x.baseline==='skr-direct'&&x.aggregate);
  assert.equal(full.aggregate.answerAccuracy,1);assert.equal(full.aggregate.bindingAccuracy,1);assert.equal(full.aggregate.residualAccuracy,1);
  assert.equal(full.metricsByFamily['bounded-multihop-graphs'].answerAccuracy,1);
  assert.equal(direct.metricsByFamily['bounded-multihop-graphs'].answerAccuracy,0);
  assert.equal(full.metricsByFamily['complete-multi-tuple-enumeration'].bindingAccuracy,1);
  assert.equal(full.metricsByFamily['rule-exception-counterevidence'].answerAccuracy,1);
  assert.equal(full.metricsByFamily['lifecycle-scope-and-role-robustness'].answerAccuracy,1);
});
