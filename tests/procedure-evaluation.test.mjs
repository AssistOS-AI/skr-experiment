import test from 'node:test';
import assert from 'node:assert/strict';
import { generateProcedureCases, runProcedureEvaluation } from '../src/evaluation/procedures.mjs';

test('60 pinned procedure contract cases distinguish opposition scope, exact relevance roles and criterion coverage',()=>{
  const cases=generateProcedureCases(),report=runProcedureEvaluation(cases);
  assert.equal(cases.length,60);assert.equal(report.status,'passed');assert.equal(report.passed,60);
  assert.deepEqual(report.metricsByFamily,{
    'contradiction-audit-scope':{cases:20,exactContractAccuracy:1},
    'relevance-exact-role':{cases:20,exactContractAccuracy:1},
    'complete-work-anchored-rubric':{cases:20,exactContractAccuracy:1}
  });
  assert.match(report.interpretation,/not produced by this suite/);
});
