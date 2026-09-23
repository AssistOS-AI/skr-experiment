import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSnapshotIndex, searchSources, queryKnowledge, openSourceRegion } from '../src/query/index.mjs';

const makeSnapshot = (id = 'snap_query') => ({ id, sources: [
  { id:'v1',sourceVersionId:'v1',sourceId:'book_a',name:'In scope',digest:'a',regions:[{id:'r1',text:'The rare ZEBRA appears beside the river.',locator:{line:1}}] },
  { id:'v2',sourceVersionId:'v2',sourceId:'book_b',name:'Out of scope',digest:'b',regions:[{id:'r2',text:'ZEBRA zebra zebra beside the river and another zebra.',locator:{line:2}}] }
], records:[{id:'fact_a',ske:'(near alice river)',sourceVersionId:'v1',regionId:'r1',quote:'The rare ZEBRA appears beside the river.',lifecycle:'current',supportState:'supported',validation:'source-checked'}] });

test('BM25 computes document statistics after applying source scope', async () => {
  const snapshot = makeSnapshot();
  const result = await searchSources({ snapshot, query:'ZEBRA', sourceScope:['v1'] });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].sourceVersionId, 'v1');
  assert.ok(result.hits[0].score > 0);
  assert.deepEqual((await searchSources({ snapshot, query:'ZEBRA', sourceScope:['v2'] })).hits.map(x=>x.sourceVersionId), ['v2']);
});

test('structural index filters candidates and reopened regions enforce scope', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'skr-query-index-'));
  try {
    const snapshot = makeSnapshot();
    const built = await buildSnapshotIndex({ snapshot, rootDir });
    assert.equal(built.documents, 2);
    const result = await queryKnowledge({ snapshot, goal:'(near alice river)', sourceScope:['v1'], rootDir });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].evidence[0].sourceVersionId, 'v1');
    assert.equal((await openSourceRegion({ snapshot, sourceVersionId:'v1',regionId:'r1',sourceScope:['v1'] })).quote, snapshot.sources[0].regions[0].text);
    await assert.rejects(openSourceRegion({ snapshot, sourceVersionId:'v2',regionId:'r2',sourceScope:['v1'] }), /outside/);
    const changed = { ...snapshot, records:[{ ...snapshot.records[0], lifecycle:'stale' }] };
    assert.equal((await queryKnowledge({ snapshot:changed,goal:'(near alice river)',sourceScope:['v1'],rootDir })).matches.length, 0);
  } finally { await rm(rootDir,{recursive:true,force:true}); }
});
