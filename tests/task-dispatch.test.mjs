import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dispatchTask} from '../src/runtime/task-dispatch.mjs';
import {procedureDefinitions} from '../src/engine/index.mjs';
import {validateChangeSet} from '../src/runtime/change-validation.mjs';

test('all six task handlers return operational answer/report bundles without reference or unavailable fallback labels',async()=>{
 const root=await mkdtemp(join(tmpdir(),'skr-dispatch-')),workspaceDir=join(root,'workspace'),procedures=Object.values(procedureDefinitions()).map(p=>({...p,active:true})),snapshot={id:'snap_dispatch',sources:[],records:[],rules:[],procedures,coverage:[],policy:{}};
 const session={async request({schema}){let output;if(schema.required.includes('ordered_steps'))output={id:'new-proc',name:'New procedure',version:'1.0.0',purpose:'Test purpose',type:'rubric',applicable_inputs_json:'["source assertions"]',parameters_json:'{}',materialization_parameters_json:'{}',ordered_steps:['inspect evidence'],evidence_obligations:['cite exact evidence'],output_schema_json:'{"type":"object"}',materialization_policy:'explicit-only',watch_scope_json:'["assertions"]',required_skills:[{name:'skr-audit-evidence',version:'1'}],lifecycle:'draft',validation:'unreviewed',active:false};else if(schema.required.includes('goal'))output={goal:'',scope:{attribution:null,time:null,modality:null,polarity:null,world:null}};else if(schema.required.includes('answer'))output={answer:'Unresolved',claims:[],citationIds:[],supportState:'unresolved',residuals:['No evidence']};else if(schema.required.includes('findings'))output={findings:[],coverage:{regionsConsidered:0}};else throw new Error('unexpected model call');return{output,sessionId:'session-test',usage:{input_tokens:1,output_tokens:1},wallMs:1}}};
 try{const common={snapshot,sourceScope:[],session,workspaceDir,checkpointDir:join(root,'checkpoints'),signal:undefined,onEvent:()=>{}};const requests=[
  {type:'QUESTION',text:'A question'},
  {type:'INGEST_SOURCE',text:'Ingest'},
  {type:'APPLY_PROCEDURE',text:'Apply',procedureId:'contradiction-audit',procedureVersion:'1.0.0'},
  {type:'BUILD_PROCEDURE',text:'Build a rubric'},
  {type:'AUDIT_PROJECT',text:'Audit'},
  {type:'EVALUATE',text:'Evaluate',fixturePath:'../../etc/passwd',evaluationTrack:'controlled-v2',baselines:['skr-direct']}
 ];for(const request of requests){const result=await dispatchTask({...common,request});assert.equal(typeof result.answerPackage?.answer,'string',request.type);assert.ok(result.validation,request.type);assert.notEqual(result.execution,'reference',request.type);assert.ok(!JSON.stringify(result).includes('unavailable'),request.type)}
  await assert.rejects(dispatchTask({...common,request:{type:'APPLY_PROCEDURE',procedureId:'contradiction-audit',procedureVersion:'0.9.0'}}),/not an active pinned version/);
  const evaluation=await dispatchTask({...common,request:{type:'EVALUATE',fixturePath:'../../etc/passwd',evaluationTrack:'controlled-v2',baselines:['skr-direct']}});assert.equal(evaluation.validation.report.fixtureId,'controlled-acceptance-v2');await assert.rejects(dispatchTask({...common,request:{type:'EVALUATE',evaluationTrack:'../../etc/passwd'}}),/Unsupported server-owned evaluation track/);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('project audit recursively scopes records rather than treating array indices as traversal state',async()=>{
 const source={id:'srcv_audit',sourceId:'source_audit',sourceVersionId:'srcv_audit',regions:[{id:'region_audit',text:'Mira owns a red bicycle.'}]};const snapshot={id:'snap_audit',sources:[source,{id:'srcv_foreign',sourceId:'foreign',sourceVersionId:'srcv_foreign',regions:[{id:'foreign_region',text:'Secret assertion.'}]}],records:[{id:'fact_audit',ske:'(owns person:mira bicycle:red)',sourceVersionId:source.sourceVersionId,regionId:'region_audit',quote:source.regions[0].text,lifecycle:'current',supportState:'supported',validation:'source-checked'},{id:'fact_foreign',ske:'(secret hidden true)',sourceVersionId:'srcv_foreign',regionId:'foreign_region',quote:'Secret assertion.',lifecycle:'current',supportState:'supported',validation:'source-checked'}],rules:[],procedures:[],coverage:[],policy:{}};
 const result=await dispatchTask({request:{type:'AUDIT_PROJECT',text:'Audit project'},snapshot,sourceScope:[source.sourceVersionId]});assert.equal(result.validation.status,'valid');assert.equal(result.coverage.claims,1);assert.equal(result.coverage.supported,1);assert.equal(result.coverage.excludedOutOfScope,1);assert.deepEqual(result.evidence.map(e=>e.id),['fact_audit']);
});

test('audit completes with a report when stale records are present, without promoting them',async()=>{
 const source={id:'old-source',sourceId:'logical-old',sourceVersionId:'old-source',regions:[{id:'old-region',text:'old quote'}]};const snapshot={id:'snap_stale_audit',sources:[source],records:[{id:'old',ske:'(owns person:mira bicycle:red)',sourceVersionId:'old-source',regionId:'old-region',quote:'old quote',lifecycle:'stale',supportState:'supported',validation:'source-checked'}],rules:[],procedures:[],coverage:[],policy:{}};
 const result=await dispatchTask({request:{type:'AUDIT_PROJECT',text:'Audit stale records'},snapshot,sourceScope:['old-source']});
 assert.equal(result.answerPackage.claims.length,0);assert.equal(result.coverage.excludedInvalidLifecycle,1);assert.equal(result.validation.status,'issues-found');assert.match(result.validation.issues.join(' '),/stale/);assert.equal(result.changeSet,undefined);
});

test('BUILD rejects on-source-update policies because no background scheduler is implemented',async()=>{
 const snapshot={id:'snap_policy',sources:[],records:[],rules:[],procedures:[],coverage:[],policy:{}};
 const session={async request(){return{output:{id:'auto_proc',name:'Automatic',version:'1.0.0',purpose:'Test',type:'rubric',applicable_inputs_json:'["assertions"]',parameters_json:'{}',materialization_parameters_json:'{}',ordered_steps:['review'],evidence_obligations:['cite'],output_schema_json:'{"type":"object"}',materialization_policy:'on-source-update',watch_scope_json:'["assertions"]',required_skills:[],lifecycle:'draft',validation:'unreviewed',active:false},sessionId:'policy-test',usage:{},wallMs:1}}};
 await assert.rejects(dispatchTask({request:{type:'BUILD_PROCEDURE',text:'Build auto'},snapshot,sourceScope:[],session}),/choose explicit-only or on-ingestion/);
});

test('INGEST_SOURCE materializes only an active manager-pinned on-ingestion procedure into one change set',async()=>{
 const source={id:'src_on_ingest',sourceId:'logical_ingest',sourceVersionId:'src_on_ingest',regions:[{id:'region_ingest',text:'Mira walks to Paris.'}]};const procedure={...procedureDefinitions()['document-literary-rubric'],active:true,materialization_policy:'on-ingestion',materialization_parameters:{criteria:['narrative-coherence']}};const snapshot={id:'snap_on_ingest',sources:[source],records:[],rules:[],procedures:[procedure],coverage:[],policy:{}};let procedureCalls=0;
 const session={async request({schema}){const required=schema.required;if(required.includes('assertions'))return{output:{assertions:[]},sessionId:'ingest-session',usage:{},wallMs:1};if(required.includes('chunkId')){procedureCalls++;const id=schema.properties.findings.items.properties.evidenceIds.items.enum[0];return{output:{chunkId:schema.properties.chunkId.enum[0],findings:[{summary:'Mira travels to Paris.',evidenceIds:[id],counterevidenceIds:[],supportState:'unresolved',score:0.7,criterion:'narrative-coherence'}],coverage:{reviewStatus:'complete',unreviewedRegionIds:[]}},sessionId:'procedure-session',usage:{},wallMs:1}}throw new Error(`Unexpected ingestion schema ${required.join(',')}`)}};
 const root=await mkdtemp(join(tmpdir(),'skr-on-ingest-'));try{const result=await dispatchTask({request:{type:'INGEST_SOURCE',text:'Review selected sources.'},snapshot,sourceScope:[source.sourceVersionId],session,checkpointDir:join(root,'checkpoint')});assert.equal(procedureCalls,1);assert.equal(result.changeSet.records.length,1);assert.equal(result.changeSet.records[0].type,'procedure-finding');assert.equal(result.changeSet.records[0].procedureVersion,procedure.version);assert.equal(result.reviewReceipts.length,1);assert.equal(result.validation.procedureFindings,1);assert.ok(result.evidence.some(e=>e.type==='source'&&e.regionId===source.regions[0].id));const validated=validateChangeSet({changeSet:result.changeSet,taskType:'INGEST_SOURCE',snapshot,sourceScope:[source.sourceVersionId],evidence:result.evidence,reviewReceipts:result.reviewReceipts});assert.equal(validated.records[0].id,result.changeSet.records[0].id);}finally{await rm(root,{recursive:true,force:true})}
});

test('server-owned procedure and store-mutation evaluation tracks use shipped fixture manifests',async()=>{
 const snapshot={id:'snap_evaltracks',sources:[],records:[],rules:[],procedures:[],coverage:[],policy:{}};for(const evaluationTrack of ['procedures-v1','mutations-v1']){const result=await dispatchTask({request:{type:'EVALUATE',text:'Run the selected engineering track.',evaluationTrack},snapshot,sourceScope:[]});assert.equal(result.validation.track,evaluationTrack);assert.ok(result.validation.report.caseCount>=50);assert.ok(!result.answerPackage.answer.includes('undefined'));}
});
