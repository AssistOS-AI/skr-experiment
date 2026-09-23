import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { CodexLunaRunner } from '../src/runtime/runners.mjs';
import { procedureReviewFingerprint } from '../src/ingestion/receipts.mjs';

const zeroScope={attribution:null,time:null,modality:null,polarity:null,world:null};

test('HTTP QUESTION validates selected-procedure receipts, audits run-local findings, and retains explain/export proof without committing',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'skr-http-question-method-'));let calls=0;
 const sessionFactory=()=>({onEvent:null,async request({schema,prompt}){
  calls++;this.onEvent?.({type:'codex.session.started',sessionId:'mocked-luna-thread'});
  let output;const required=schema.required;
  if(required.includes('reasoningNotes'))output={goal:'(visits person:mira city:paris)',scope:zeroScope,reasoningNotes:'Use the scoped travel question.'};
  else if(required.includes('proposals'))output={proposals:[],subgoals:[],uncertainties:[]};
  else if(required.includes('chunkId')){const evidenceId=schema.properties.findings.items.properties.evidenceIds.items.enum[0];output={chunkId:schema.properties.chunkId.enum[0],findings:[{summary:'Mira travels to Paris in the passage.',evidenceIds:[evidenceId],counterevidenceIds:[],supportState:'unresolved',score:0.7,criterion:'narrative-coherence'}],coverage:{reviewStatus:'complete',unreviewedRegionIds:[]}};}
  else if(required.includes('answer')){const data=prompt.split('Evidence JSON:\n').at(-1);const evidence=JSON.parse(data);const finding=evidence.find(x=>x.type==='procedure-finding');assert.ok(finding,'Expected the run-local finding in the answer evidence context');output={answer:'A provisional procedure assessment is available.',claims:[{text:'A provisional procedure assessment is available.',citationIds:[finding.id]}],citationIds:[finding.id],supportState:'unresolved',residuals:[]};}
  else throw new Error(`Unexpected Codex request schema: ${required.join(',')}`);
  return{output,sessionId:'mocked-luna-thread',usage:{input_tokens:10,output_tokens:3},wallMs:1};
 },async status(){return{sessionId:'mocked-luna-thread',requests:calls,totalUsage:{input_tokens:calls*10,output_tokens:calls*3},usageLedger:[]}}});
 const app=createApp({dataDir,runner:new CodexLunaRunner(),sessionFactory,trustedLocal:true}),address=await app.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${address.port}/api`;
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true});});
 const api=async(path,method='GET',body)=>{const response=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()};};
 const project=(await api('/projects','POST',{name:'Procedure question'})).data.project;
 const sourceResponse=await api(`/projects/${project.id}/sources`,'POST',{name:'journey.txt',mimeType:'text/plain',content:Buffer.from('Mira walks to Paris.').toString('base64')});assert.equal(sourceResponse.status,201);
 const pinned=sourceResponse.data.snapshot,source=sourceResponse.data.source,procedure=pinned.procedures.find(p=>p.id==='document-literary-rubric'&&p.active!==false);assert.ok(procedure);
 const started=await api(`/projects/${project.id}/requests`,'POST',{type:'QUESTION',text:'Assess Mira’s journey in the passage.',goal:'(visits person:mira city:paris)',procedureId:procedure.id,procedureVersion:procedure.version,parameters:{},sourceScope:[source.sourceVersionId]});assert.equal(started.status,202);
 let run;for(let i=0;i<300;i++){run=(await api(`/runs/${started.data.runId}`)).data.run;if(['completed','failed','cancelled'].includes(run.status))break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(run.status,'completed',run.error);assert.equal(run.execution,'actual-coding-agent');assert.equal(run.model,'gpt-6-luna');assert.ok(calls>=4);
 assert.equal(run.result.validation.audit.status,'valid');assert.equal(run.result.validation.runLocalProcedureRecords,1);assert.equal(run.evidenceContext.procedureRecords.length,1);assert.equal(run.evidenceContext.procedureReviewReceipts.length,1);
 const localId=run.evidenceContext.procedureRecords[0].id;assert.ok(run.result.evidence.some(e=>e.id===localId&&e.type==='procedure-finding'));assert.ok(run.result.validation.audit.checkedEvidenceIds.includes(localId),'the audit must actually traverse the run-local finding');
 const after=await app.store.getSnapshot(project.id);assert.equal(after.id,pinned.id);assert.equal(after.records.some(r=>r.id===localId),false);
 const explain=await api(`/runs/${run.id}/explain`);assert.equal(explain.status,200);assert.equal(explain.data.evidenceContext.procedureRecords[0].id,localId);assert.equal(explain.data.evidenceContext.procedureReviewReceipts.length,1);
 const exported=await api(`/runs/${run.id}`);assert.equal(exported.status,200);assert.equal(exported.data.run.evidenceContext.procedureRecords[0].id,localId);assert.equal(exported.data.run.result.validation.audit.status,'valid');
 assert.equal(run.evidenceContext.procedureReviewReceipts[0].fingerprint,procedureReviewFingerprint(run.evidenceContext.procedureRecords[0]));
});

test('on-ingestion skill dependencies are approved and mounted before extraction begins',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'skr-http-ingestion-skill-'));let modelCalls=0;
 const app=createApp({dataDir,runner:new CodexLunaRunner(),sessionFactory:()=>{modelCalls++;throw new Error('Session must not start when an on-ingestion skill is unapproved')},trustedLocal:true}),address=await app.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${address.port}/api`;
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true});});
 const api=async(path,method='GET',body)=>{const response=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()};};
 const project=(await api('/projects','POST',{name:'Missing on-ingestion skill'})).data.project,snapshot=await app.store.getSnapshot(project.id);
 const draft={id:'auto_method',name:'Automatic method',version:'1.0.0',purpose:'Run during source ingestion.',type:'rubric',applicable_inputs:['source passages'],parameters:{},materialization_parameters:{},ordered_steps:['Review each passage.'],evidence_obligations:['Cite each finding.'],output_schema:{type:'array'},watch_scope:['assertions'],materialization_policy:'on-ingestion',required_skills:[{name:'not-approved-method-skill',version:'1'}],lifecycle:'draft',validation:'unreviewed',active:false};
 const draftSnapshot=await app.store.commit(project.id,snapshot.id,{procedures:[draft]});await app.store.approveProcedure(project.id,draftSnapshot.id,{id:draft.id,version:draft.version,reviewedBy:'trusted-local'});
 const source=(await api(`/projects/${project.id}/sources`,'POST',{name:'small.txt',mimeType:'text/plain',content:Buffer.from('A small scoped passage.').toString('base64')})).data.source;
 const response=await api(`/projects/${project.id}/requests`,'POST',{type:'INGEST_SOURCE',text:'Extract this source.',sourceScope:[source.sourceVersionId]});assert.equal(response.status,409);assert.match(response.data.error,/not approved or has changed/);assert.equal(modelCalls,0);assert.equal((await app.store.listRuns(project.id)).length,0);
});
