import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChangeSet } from '../src/runtime/change-validation.mjs';
import { makeProcedureReviewReceipt } from '../src/ingestion/receipts.mjs';

const snapshot = {
  id: 'snap_1',
  sources: [{ id: 'srcv_1', sourceVersionId: 'srcv_1', sourceId: 'book_1', regions: [{ id: 'region_1', text: 'The service is active.', locator: { type: 'text-line', line: 1 } }] }],
  procedures: [{ id: 'rubric', version: '1.0', purpose: 'Review claims', type: 'rubric', active: true }],
  records: [{ id: 'fact_1', sourceVersionId: 'srcv_1', regionId: 'region_1', quote: 'The service is active.', ske: '(active service)', lifecycle: 'current' }]
};

test('allows source scoped ingestion coverage and adds deterministic coverage IDs', () => {
  const input = { coverage: [{ sourceVersionId: 'srcv_1', regionId: 'region_1', state: 'deferred', reason: 'No extractor' }] };
  const validated = validateChangeSet({ changeSet: input, taskType: 'INGEST_SOURCE', snapshot, sourceScope: ['srcv_1'] });
  assert.match(validated.coverage[0].id, /^coverage_[a-f0-9]{24}$/);
  assert.equal(input.coverage[0].id, undefined);
});

test('keeps text-to-SKE interpretation unresolved instead of claiming citation semantics', () => {
  const validated = validateChangeSet({ changeSet: { records: [
    { id: 'fact_2', ske: '(healthy service)', sourceVersionId: 'srcv_1', regionId: 'region_1', quote: 'The service is active.', lifecycle: 'current' }
  ] }, taskType: 'INGEST_SOURCE', snapshot, sourceScope: ['srcv_1'] });
  assert.equal(validated.records[0].lifecycle, 'staged');
  assert.equal(validated.records[0].supportState, 'unresolved');
  assert.equal(validated.records[0].validation, 'unreviewed-source-interpretation');
  assert.throws(() => validateChangeSet({ changeSet: { records: [{ id: 'bad_fact', ske: '(healthy service)', sourceVersionId: 'srcv_1', regionId: 'region_1', supportState: 'supported' }] }, taskType: 'INGEST_SOURCE', snapshot, sourceScope: ['srcv_1'] }), /cannot self-assert semantic support/);
});

test('exact ground SKE quoted verbatim from a source region becomes source-checked', () => {
  const structuredSnapshot = { ...snapshot, sources: [{ ...snapshot.sources[0], regions: [...snapshot.sources[0].regions, { id: 'ske_region', text: '(active service)', locator: { type: 'text-line', line: 2 } }] }] };
  const validated = validateChangeSet({ changeSet: { records: [{ id: 'exact_fact', ske: '(active service)', sourceVersionId: 'srcv_1', regionId: 'ske_region', quote: '(active service)', lifecycle: 'staged' }] }, taskType: 'INGEST_SOURCE', snapshot: structuredSnapshot, sourceScope: ['srcv_1'] });
  assert.equal(validated.records[0].lifecycle, 'current');
  assert.equal(validated.records[0].supportState, 'supported');
  assert.equal(validated.records[0].validation, 'source-checked');
  assert.equal(validated.records[0].origin, 'source-assertion');
});

test('derived SKE must replay an exact pinned rule and remains unresolved over unreviewed premises', () => {
  const withRule = { ...snapshot, records: [...snapshot.records, { id: 'r1', version: '1', premises: ['(active ?x)'], conclusion: '(healthy ?x)', lifecycle: 'current' }] };
  const validated = validateChangeSet({ changeSet: { records: [{ id: 'd1', type: 'rule-finding', ske: '(healthy service)', procedureId: 'r1', procedureVersion: '1', transformation: 'rule-replay', premiseIds: ['fact_1'], dependencies: ['fact_1'], lifecycle: 'current' }] }, taskType: 'APPLY_PROCEDURE', snapshot: withRule, sourceScope: ['srcv_1'] });
  assert.equal(validated.records[0].lifecycle, 'staged');
  assert.equal(validated.records[0].supportState, 'unresolved');
  assert.throws(() => validateChangeSet({ changeSet: { records: [{ id: 'd2', ske: '(reviewed service)', dependencies: ['fact_1'] }] }, taskType: 'APPLY_PROCEDURE', snapshot: withRule, sourceScope: ['srcv_1'] }), /requires explicit rule-replay/);
});

test('rejects unapproved change keys, malformed expressions, stale or out of scope dependencies', () => {
  assert.throws(() => validateChangeSet({ changeSet: { policy: { open: true } }, taskType: 'INGEST_SOURCE', snapshot, sourceScope: ['srcv_1'] }), /cannot publish policy/);
  assert.throws(() => validateChangeSet({ changeSet: { records: [{ id: 'bad', ske: '(broken', sourceVersionId: 'srcv_1', regionId: 'region_1' }] }, taskType: 'INGEST_SOURCE', snapshot, sourceScope: ['srcv_1'] }), /invalid SKE/);
  assert.throws(() => validateChangeSet({ changeSet: { records: [{ id: 'foreign', type: 'rule-finding', dependencies: ['foreign_fact'] }] }, taskType: 'APPLY_PROCEDURE', snapshot, sourceScope: ['srcv_1'] }), /missing or stale dependency/);
  assert.throws(() => validateChangeSet({ changeSet: { records: [{ id: 'leak', sourceVersionId: 'srcv_elsewhere', regionId: 'elsewhere' }] }, taskType: 'INGEST_SOURCE', snapshot, sourceScope: ['srcv_1'] }), /outside the authorized scope/);
  assert.throws(() => validateChangeSet({ changeSet: { records: [{ id: 'mismatch', sourceVersionId: 'srcv_elsewhere', sourceId: 'book_1', regionId: 'region_1' }] }, taskType: 'INGEST_SOURCE', snapshot, sourceScope: ['srcv_1'] }), /outside the authorized scope/);
});

test('rejects cycles and unsupported derived evidence', () => {
  const changeSet = { records: [{ id: 'a', type: 'rule-finding', dependencies: ['b'] }, { id: 'b', type: 'rule-finding', dependencies: ['a'] }] };
  assert.throws(() => validateChangeSet({ changeSet, taskType: 'APPLY_PROCEDURE', snapshot, sourceScope: ['srcv_1'] }), /cyclic record dependency/);
  assert.throws(() => validateChangeSet({ changeSet: {}, taskType: 'APPLY_PROCEDURE', snapshot, sourceScope: ['srcv_1'], evidence: [{ id: 'd', type: 'derived', premiseIds: ['x'], transformation: 'guess' }] }), /unsupported transformation/);
});

test('a valid evidence item cannot mask a stale pinned record with the same ID', () => {
  const staleSnapshot = { ...snapshot, records: [...snapshot.records, { id: 'stale_fact', lifecycle: 'stale', dependencies: [] }] };
  const evidence = [{ id: 'stale_fact', type: 'source', sourceVersionId: 'srcv_1', regionId: 'region_1', quote: 'The service is active.' }];
  assert.throws(() => validateChangeSet({ changeSet: { records: [{ id: 'uses_stale', type: 'rule-finding', dependencies: ['stale_fact'] }] }, taskType: 'APPLY_PROCEDURE', snapshot: staleSnapshot, sourceScope: ['srcv_1'], evidence }), /stale dependency/);
});

test('procedure finding evidence is accepted only when it matches the staged reviewed record and receipt', () => {
  const passageId='passage_1';
  const finding={id:'local_finding',type:'procedure-finding',procedureId:'rubric',procedureVersion:'1.0',parameters:{focus:'style'},summary:'Procedural assessment from reviewed source evidence.',score:null,criterion:'style',evidenceIds:[passageId],counterevidenceIds:[],dependencies:[passageId,'srcv_1'],sourceSnapshotId:snapshot.id,lifecycle:'current',supportState:'unresolved',validation:'model-reviewed',review:{model:'gpt-6-luna',sessionId:'session_1',reviewedAt:'2026-09-23T00:00:00.000Z',method:'whole-source-procedure-application'}};
  const passage={id:passageId,type:'source',sourceVersionId:'srcv_1',regionId:'region_1',quote:'The service is active.'};
  const receipt=makeProcedureReviewReceipt(finding,{sessionId:'session_1',reviewedAt:finding.review.reviewedAt});
  const evidence=[passage,{...finding}];
  const validated=validateChangeSet({changeSet:{records:[finding]},taskType:'APPLY_PROCEDURE',snapshot,sourceScope:['srcv_1'],evidence,reviewReceipts:[receipt]});
  assert.equal(validated.records[0].id,'local_finding');
  assert.throws(()=>validateChangeSet({changeSet:{records:[finding]},taskType:'APPLY_PROCEDURE',snapshot,sourceScope:['srcv_1'],evidence:[passage,{...finding,summary:'Changed after review.'}],reviewReceipts:[receipt]}),/differs from its validated procedure-finding record/);
});

test('procedure builds require exact immutable version fields', () => {
  assert.throws(() => validateChangeSet({ changeSet: { procedures: [{ id: 'new_proc', version: '1' }] }, taskType: 'BUILD_PROCEDURE', snapshot }), /purpose and type/);
  assert.throws(() => validateChangeSet({ changeSet: { procedures: [{ id: 'new_proc', version: '1', purpose: 'Good', type: 'rubric' }] }, taskType: 'BUILD_PROCEDURE', snapshot }), /ordered_steps/);
  assert.throws(() => validateChangeSet({ changeSet: { procedures: [{ id: 'new_proc', version: '1', purpose: 'Good', type: 'rubric' }] }, taskType: 'INGEST_SOURCE', snapshot }), /cannot publish procedures/);
  const draft = validateChangeSet({ changeSet: { procedures: [{ id: 'new_proc', version: '1', purpose: 'Good', type: 'rubric', lifecycle: 'draft', validation: 'unreviewed', active: false }] }, taskType: 'BUILD_PROCEDURE', snapshot });
  assert.equal(draft.procedures[0].active, false);
});
