import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileEntityAliases, undoEntityReconciliation } from '../src/ingestion/entities.mjs';
import { reviewAssertions, materializeProcedures, ingestProject, retryIngestionChunk } from '../src/ingestion/index.mjs';
import { validateChangeSet } from '../src/runtime/change-validation.mjs';
import { queryKnowledge } from '../src/query/index.mjs';

test('malformed SKE is repaired in a separate turn before independent entailment review', async () => {
  const source={id:'sv1',sourceVersionId:'sv1',sourceId:'book1',regions:[{id:'region1',text:'Rabbit plays with a ball.',locator:{line:1}}]};
  const snapshot={id:'snap1',sources:[source],records:[]}; let call=0;
  const session={request:async({schema})=>{
    call++;
    if(call===1)return {output:{repairs:[{candidateId:'cand1',ske:'(plays_with rabbit ball)',quote:'Rabbit plays with a ball.'}]},sessionId:'luna-test'};
    assert.equal(call,2);
    const candidateId=schema.properties.reviews.items.properties.candidateId.enum[0];
    return {output:{reviews:[{candidateId,decision:'entailed',rationale:'The cited sentence directly says rabbit plays with a ball.',qualifiers:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:'fictional narrative'},entityDecisions:[],counterevidence:[]}]},sessionId:'luna-test'};
  }};
  const result=await reviewAssertions({snapshot,sourceScope:['sv1'],session,candidates:[{candidateId:'cand1',sourceVersionId:'sv1',sourceId:'book1',regionId:'region1',quote:'Rabbit plays the ball.',ske:'plays_with(rabbit,ball)',qualifiers:{},entities:[]}]});
  assert.equal(call,2); assert.equal(result.records.length,1); assert.equal(result.records[0].ske,'(plays_with rabbit ball)');
  assert.equal(result.records[0].validation,'model-reviewed'); assert.equal(result.receipts[0].sessionId,'luna-test');
});

test('assertion review receives adjacent passage context but binds proof to the exact cited region', async () => {
  const source={id:'sv_adj',sourceVersionId:'sv_adj',sourceId:'book_adj',regions:[
    {id:'r1',text:'The rabbit was warned to stay home.',locator:{line:1}},
    {id:'r2',text:'Peter ran into the garden.',locator:{line:2}},
    {id:'r3',text:'He lost his shoes.',locator:{line:3}}
  ]};
  const snapshot={id:'snap_adj',sources:[source],records:[]};
  const session={request:async({prompt,schema})=>{
    const marker='Candidates, exact cited text, and neighboring context:\n',payload=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));
    assert.deepEqual(payload[0].adjacentRegions.map(r=>r.regionId),['r1','r2','r3']);
    assert.equal(payload[0].adjacentRegions[0].role,'adjacent-context-only');
    assert.equal(payload[0].adjacentRegions[1].role,'cited-claim-region');
    assert.equal(payload[0].quote,'Peter ran into the garden.');
    const candidateId=schema.properties.reviews.items.properties.candidateId.enum[0];
    return{output:{reviews:[{candidateId,decision:'entailed',rationale:'The cited line directly states the event.',qualifiers:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:'fictional narrative'},entityDecisions:[],counterevidence:[]}]},sessionId:'adjacent-test'};
  }};
  const result=await reviewAssertions({snapshot,sourceScope:['sv_adj'],session,candidates:[{candidateId:'adj_candidate',sourceVersionId:'sv_adj',regionId:'r2',quote:'Peter ran into the garden.',ske:'(entered peter garden)',qualifiers:{},entities:[]}]});
  assert.equal(result.records.length,1);
  assert.equal(result.records[0].regionId,'r2');
  assert.equal(result.records[0].quote,'Peter ran into the garden.');
  assert.equal(result.records[0].qualifiers.world,'fictional narrative');
});

test('targeted retry reopens only a named partial ingestion chunk under its exact checkpoint fingerprint', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'skr-ingestion-retry-'));
  try {
    const source={id:'sv_retry',sourceVersionId:'sv_retry',sourceId:'book_retry',name:'Retry fixture',digest:'digest',readerProfile:{id:'text-test'},regions:[{id:'r1',text:'A rabbit hops.',locator:{line:1}}]};
    const snapshot={id:'snap_retry',sources:[source],records:[],procedures:[],policy:{}};
    const failed={request:async()=>{throw new Error('transient extraction interruption');}};
    const partial=await ingestProject({snapshot,sourceScope:['sv_retry'],session:failed,checkpointDir:dir});
    assert.equal(partial.answerPackage.supportState,'partial');
    assert.equal(partial.checkpoint.pendingChunks,1);
    const args={checkpointDir:dir,sourceVersionId:'sv_retry',chunkId:'chunk_1',expectedFingerprint:partial.checkpoint.fingerprint};
    await assert.rejects(retryIngestionChunk({...args,expectedFingerprint:'wrong-pin'}),/exact pinned ingestion checkpoint fingerprint/);
    const marked=await retryIngestionChunk(args);
    assert.equal(marked.status,'retry-requested');
    const resumed={request:async()=>({output:{assertions:[]},sessionId:'retry-test',usage:{input_tokens:2},wallMs:1})};
    const complete=await ingestProject({snapshot,sourceScope:['sv_retry'],session:resumed,checkpointDir:dir});
    assert.equal(complete.answerPackage.supportState,'unresolved');
    assert.equal(complete.checkpoint.completedChunks,1);
    assert.equal(complete.checkpoint.pendingChunks,0);
    assert.equal(complete.coverage.find(c=>c.regionId==='r1').state,'processed');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('cross-batch context synthesis links and reviews related assertions from distinct initial batches', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'skr-cross-context-'));
  try {
    const regions=Array.from({length:40},(_,i)=>({id:`r${i+1}`,text:`${i===0||i===39?'Rabbit':'Account'} testimony ${i+1} ${('detail'+i+' ').repeat(115)}`,locator:{type:'text-line',line:i+1,start:i*1000,end:i*1000+900,offsetUnit:'utf16-code-unit'}}));
    const source={id:'sv_cross',sourceVersionId:'sv_cross',sourceId:'book_cross',name:'Cross-batch fixture',digest:'cross-digest',readerProfile:{id:'text-test'},regions};
    const snapshot={id:'snap_cross',sources:[source],records:[],procedures:[],policy:{}};
    const session={request:async({prompt})=>{
      if(prompt.startsWith('Extract only explicit, atomic factual propositions')){
        const list=JSON.parse(prompt.slice(prompt.indexOf('Regions:\n')+'Regions:\n'.length));
        return {output:{assertions:list.map(row=>{const i=Number(row.regionId.slice(1));return{ske:i===1?'(owns rabbit hero)':i===40?'(lives_with rabbit mother)':`(owns entity_${i} thing_${i})`,regionId:row.regionId,quote:row.text,qualifiers:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:'fictional narrative'},entities:[]};})},sessionId:'cross-batch-test'};
      }
      if(prompt.includes('Candidates, exact cited text, and neighboring context:')){
        const marker='Candidates, exact cited text, and neighboring context:\n',start=prompt.indexOf(marker)+marker.length;
        const candidates=JSON.parse(prompt.slice(start));
        return {output:{reviews:candidates.map(c=>({candidateId:c.candidateId,decision:'entailed',rationale:'Exact quote supplied.',qualifiers:c.qualifiers,entityDecisions:[],counterevidence:[]}))},sessionId:'cross-batch-test'};
      }
      if(prompt.startsWith('Within-batch cross-chapter context pass'))return{output:{relations:[]},sessionId:'cross-batch-test'};
      if(prompt.startsWith('Bounded cross-batch context synthesis')){
        const rows=JSON.parse(prompt.slice(prompt.indexOf('Candidate assertion pairs:\n')+'Candidate assertion pairs:\n'.length));
        const pair=rows[0];return{output:{relations:[{pairId:pair.pairId,relationship:'cross-chapter-dependency',summary:'The opening and closing assertions connect Rabbit to the family relationship.',premiseIds:pair.assertions.map(x=>x.id),counterevidenceIds:[]}]},sessionId:'cross-batch-test'};
      }
      throw new Error(`Unexpected mock turn: ${prompt.slice(0,80)}`);
    }};
    const result=await ingestProject({snapshot,sourceScope:['sv_cross'],session,checkpointDir:dir});
    assert.ok(result.answerPackage.coverage.contextBatches>1,JSON.stringify({contextBatches:result.answerPackage.coverage.contextBatches,assertions:result.changeSet.records.filter(r=>r.type==='source-assertion').length,coverage:result.answerPackage.coverage}));
    assert.equal(result.answerPackage.coverage.crossBatchAnalysis,'complete');
    const finding=result.changeSet.records.find(r=>r.type==='contextual-finding'&&r.review.method==='cross-batch-linked-context-synthesis');
    assert.ok(finding);
    assert.equal(finding.premiseIds.length,2);
    const premises=finding.premiseIds.map(id=>result.changeSet.records.find(r=>r.id===id));
    assert.ok(premises.every(Boolean));
    assert.deepEqual(new Set(premises.map(r=>r.regionId)),new Set(['r1','r40']));
    assert.ok(result.reviewReceipts.some(r=>r.recordId===finding.id&&r.type==='context-review'));
    assert.equal(result.answerPackage.residuals.length,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('entity alias reconciliation changes structural matching and undo restores exact prior matches', async () => {
  const original={id:'claim1',ske:'(visits entity_rabbit_alias garden)',sourceVersionId:'sv1',regionId:'region1',quote:'Rabbit visits the garden.',lifecycle:'current',supportState:'supported',validation:'model-reviewed',entityMentions:[{surface:'Rabbit',canonicalName:'Rabbit',entityId:'entity_rabbit_alias',decision:'new'}],qualifiers:{world:'fictional'}};
  const base={id:'snap_entities',sources:[{id:'sv1',sourceVersionId:'sv1',sourceId:'book1',regions:[{id:'region1',text:original.quote,locator:{line:1}}]}],records:[original]};
  assert.equal((await queryKnowledge({snapshot:base,goal:'(visits entity_rabbit garden)'})).matches.length,0);
  const plan=reconcileEntityAliases({records:[original],fromEntityId:'entity_rabbit_alias',toEntityId:'entity_rabbit',operationId:'reconcile_1'});
  assert.equal(plan.changeSet.records[0].ske,'(visits entity_rabbit garden)');
  assert.equal(plan.changeSet.records[0].entityMentions[0].entityId,'entity_rabbit');
  const merged={...base,id:'snap_entities_merged',records:plan.changeSet.records};
  assert.equal((await queryKnowledge({snapshot:merged,goal:'(visits entity_rabbit garden)'})).matches.length,1);
  assert.deepEqual(undoEntityReconciliation(plan.undo),{records:[original]});
  const restored={...base,id:'snap_entities_restored',records:undoEntityReconciliation(plan.undo).records};
  assert.equal((await queryKnowledge({snapshot:restored,goal:'(visits entity_rabbit garden)'})).matches.length,0);
  assert.equal((await queryKnowledge({snapshot:restored,goal:'(visits entity_rabbit_alias garden)'})).matches.length,1);
});

test('batch review reconciles explicit same-character references but keeps same-name identities distinct and preserves omitted qualifiers', async () => {
  const regions=['Peter entered the burrow yesterday.','Peter returned to the burrow yesterday.','Another Peter visited the garden yesterday.'].map((text,i)=>({id:`r${i+1}`,text,locator:{line:i+1}}));
  const snapshot={id:'snap_batch',sources:[{id:'sv1',sourceVersionId:'sv1',sourceId:'book1',regions}],records:[]};
  const candidates=regions.map((r,i)=>({candidateId:`c${i+1}`,sourceVersionId:'sv1',sourceId:'book1',regionId:r.id,quote:r.text,ske:`(visited peter place_${i+1})`,qualifiers:{attribution:'narrator',time:'yesterday',modality:'possible',polarity:'negative',world:'story'},entities:[{surface:'Peter',canonicalName:'Peter',kind:'person'}]}));
  const id1=`entity_${createHash('sha256').update('sv1:r1:(visited peter place_1):peter').digest('hex').slice(0,24)}`; let call=0;
  const session={request:async({schema})=>{
    call++; const ids=schema.properties.reviews.items.properties.candidateId.enum;
    return {sessionId:'batch-review',output:{reviews:ids.map(candidateId=>({candidateId,decision:'entailed',rationale:'Quote directly supports its qualified assertion.',qualifiers:{attribution:null,time:null,modality:null,polarity:null,world:null},entityDecisions:[{surface:'Peter',decision:candidateId==='c2'?'same-as':'new',entityId:candidateId==='c2'?id1:null,canonicalName:'Peter',rationale:'same identity explicitly established'}],counterevidence:[]}))}};
  }};
  const result=await reviewAssertions({candidates,snapshot,sourceScope:['sv1'],session});
  assert.equal(call,1); assert.equal(result.records.length,3);
  const ids=result.records.map(r=>r.entityMentions.find(e=>e.surface==='Peter').entityId);
  assert.equal(ids[0],ids[1]); assert.notEqual(ids[1],ids[2]);
  for (const record of result.records) { assert.equal(record.qualifiers.modality,'possible'); assert.equal(record.qualifiers.polarity,'negative'); assert.equal(record.qualifiers.time,'yesterday'); assert.equal(record.qualifiers.world,'story'); }
});

test('procedure materialization requires exact pinned versions and records counterevidence as invalidating dependencies', async () => {
  const source={id:'sv1',sourceVersionId:'sv1',sourceId:'book1',regions:[{id:'r1',text:'The rabbit enters the garden.',locator:{line:1}},{id:'r2',text:'The rabbit does not enter the garden.',locator:{line:2}},{id:'r3',text:'The otter waits beside the reeds.',locator:{line:3}}]};
  const baseRecord=(id,regionId,quote,polarity='positive')=>({id,type:'source-assertion',ske:'(enters rabbit garden)',sourceVersionId:'sv1',sourceId:'book1',regionId,quote,lifecycle:'current',supportState:'supported',validation:'model-reviewed',qualifiers:{attribution:null,time:null,modality:'asserted',polarity,world:'story'}});
  const snapshot={id:'snap_proc',sources:[source],procedures:[{id:'rubric',version:'2.0',active:true,purpose:'Assess',type:'rubric',ordered_steps:['Compare sources'],evidence_obligations:['Cite both'],output_schema:{type:'object'}}],records:[baseRecord('fact_yes','r1',source.regions[0].text),baseRecord('fact_no','r2',source.regions[1].text,'negative')]};
  await assert.rejects(materializeProcedures({snapshot,procedures:snapshot.procedures,procedureIds:['rubric'],sourceScope:['sv1'],session:{request(){}}}),/requires an exact pinned version/);
  const rawCounter=`passage_${createHash('sha256').update('sv1:r2').digest('hex').slice(0,24)}`;
  const session={request:async({prompt,schema})=>{assert.match(prompt,/The otter waits beside the reeds/);const allowed=schema.properties.findings.items.properties.counterevidenceIds.items.enum;assert.ok(allowed.includes(rawCounter));assert.equal(schema.properties.chunkId.enum[0],'chunk_1');return {sessionId:'procedure-session',output:{chunkId:'chunk_1',findings:[{summary:'The claim is contradicted by the second passage.',evidenceIds:['fact_yes'],counterevidenceIds:[rawCounter],supportState:'contested',score:0.2,criterion:'counterevidence'}],coverage:{reviewStatus:'complete',unreviewedRegionIds:[]}}};}};
  const bundle=await materializeProcedures({snapshot,procedures:snapshot.procedures,procedureIds:[{id:'rubric',version:'2.0'}],parameters:{rubric:{criterion:'characterization'}},sourceScope:['sv1'],session});
  const finding=bundle.changeSet.records[0]; assert.deepEqual(finding.dependencies,['fact_yes',rawCounter,'sv1']);
  assert.ok(bundle.coverage.some(c=>c.regionId==='r3'&&c.state==='processed'));
  const parameterRow=bundle.coverage.find(c=>c.regionId==='r1');assert.deepEqual(parameterRow.parameters,{criterion:'characterization'});assert.equal(parameterRow.parameterFingerprint,createHash('sha256').update('{"criterion":"characterization"}').digest('hex'));
  const otherParameters=await materializeProcedures({snapshot,procedureIds:[{id:'rubric',version:'2.0'}],parameters:{rubric:{criterion:'style'}},sourceScope:['sv1'],session});
  assert.notEqual(parameterRow.id,otherParameters.coverage.find(c=>c.regionId==='r1').id,'coverage IDs must not alias across parameter sets');
  const validated=validateChangeSet({changeSet:bundle.changeSet,taskType:'APPLY_PROCEDURE',snapshot,sourceScope:['sv1'],evidence:bundle.evidence,reviewReceipts:bundle.reviewReceipts});
  assert.equal(validated.records[0].supportState,'contested');
  await assert.rejects(materializeProcedures({snapshot,procedures:snapshot.procedures,procedureIds:[{id:'rubric',version:'1.0'}],sourceScope:['sv1'],session}),/not the active exact version pinned/);
});

test('procedure coverage uses exact region IDs rather than a model-reported region count', async()=>{
  const source={id:'sv_cov',sourceVersionId:'sv_cov',sourceId:'book_cov',regions:[{id:'r1',text:'Narrative passage one.',locator:{line:1}},{id:'r2',text:'Narrative passage two.',locator:{line:2}},{id:'r3',text:'Narrative passage three.',locator:{line:3}}]};
  const procedure={id:'rubric',version:'1.0',active:true,purpose:'Review passages',type:'rubric',ordered_steps:['Read','Assess'],evidence_obligations:['Cite evidence'],output_schema:{type:'object'}};
  const snapshot={id:'snap_cov',sources:[source],records:[],procedures:[procedure]};
  const cited=`passage_${createHash('sha256').update('sv_cov:r1').digest('hex').slice(0,24)}`;
  const session={request:async({schema})=>({sessionId:'coverage-session',output:{chunkId:schema.properties.chunkId.enum[0],findings:[{summary:'Observed in first region.',evidenceIds:[cited],counterevidenceIds:[],supportState:'unresolved',score:null,criterion:'observation'}],coverage:{reviewStatus:'partial',unreviewedRegionIds:['r3']}}})};
  const result=await materializeProcedures({snapshot,procedureIds:[{id:'rubric',version:'1.0'}],sourceScope:['sv_cov'],session});
  assert.equal(result.changeSet.records.length,1,'a reviewed finding must not be dropped due to an unrelated incomplete region');
  assert.deepEqual(result.coverage.map(c=>[c.regionId,c.state]),[['r1','processed'],['r2','processed'],['r3','partial']]);
  assert.equal(result.validation.incompleteRegions,1);
  assert.ok(result.answerPackage.residuals.some(r=>/1 selected work regions/.test(r.reason)));
});
