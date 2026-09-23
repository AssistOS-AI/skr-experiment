import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadFrozenFixture } from '../src/evaluation/frozen-fixture.mjs';

test('frozen fixture loader accepts exact digest and rejects edits before evaluation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'skr-frozen-fixture-'));
  try{const path=join(dir,'fixture.json'),bytes=Buffer.from(JSON.stringify({id:'case-set',cases:[{id:'a'}]}));await writeFile(path,bytes);await writeFile(`${path}.lock.json`,JSON.stringify({fixture:'fixture.json',fixtureId:'case-set',sha256:createHash('sha256').update(bytes).digest('hex'),caseCount:1}));assert.equal((await loadFrozenFixture(path)).fixture.cases.length,1);await writeFile(path,JSON.stringify({id:'case-set',cases:[{id:'b'}]}));await assert.rejects(loadFrozenFixture(path),/hash mismatch/);}finally{await rm(dir,{recursive:true,force:true});}
});
