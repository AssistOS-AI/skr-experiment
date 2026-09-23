import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMutationFixture, runMutationEvaluation } from '../src/evaluation/mutations.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('mutation fixtures have controlled size and store-backed updates, activations, forks and rebases pass',async()=>{
 const fixture=buildMutationFixture({count:60});assert.equal(fixture.cases.length,60);assert.throws(()=>buildMutationFixture({count:49}),RangeError);assert.ok(fixture.cases.some(x=>x.parameters.dependencyDepth>1));assert.ok(fixture.cases.some(x=>x.parameters.childDraftCollision));assert.ok(fixture.cases.some(x=>x.parameters.casConflict));
 const report=await runMutationEvaluation({fixturePath:'fixtures/mutations-v1.json'});assert.equal(report.status,'passed');assert.equal(report.caseCount,60);assert.equal(report.passed,60);assert.equal(report.failed,0);for(const family of Object.values(report.families))assert.ok(family.passed>0);
});

test('unknown fixture mutation families are reported as failures, never treated as rebases',async()=>{
 const root=await mkdtemp(join(tmpdir(),'skr-mutation-invalid-'));try{const fixture=buildMutationFixture({count:50});fixture.cases[0].family='unknown-family';const bytes=JSON.stringify(fixture);const path=join(root,'invalid.json');await writeFile(path,bytes);await writeFile(`${path}.lock.json`,JSON.stringify({fixtureId:fixture.id,sha256:createHash('sha256').update(bytes).digest('hex'),caseCount:fixture.cases.length}));const report=await runMutationEvaluation({fixturePath:path});assert.equal(report.status,'failed');assert.equal(report.failed,1);assert.match(report.results[0].error,/Unknown mutation family/);}finally{await rm(root,{recursive:true,force:true})}
});
