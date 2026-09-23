import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { dispatchTask } from '../src/runtime/task-dispatch.mjs';

const zeroScope={attribution:null,time:null,modality:null,polarity:null,world:null};
const session={async request({schema}){const req=schema?.required??[];let output;if(req.includes('ordered_steps'))output={id:'draft_method',name:'Draft Method',version:'1.0.0',purpose:'Assess authorized source evidence against explicit criteria.',type:'rubric',applicable_inputs_json:'["source assertions"]',parameters_json:'{}',materialization_parameters_json:'{}',ordered_steps:['Inspect each scoped assertion.'],evidence_obligations:['Cite exact source evidence.'],output_schema_json:'{"type":"object"}',materialization_policy:'explicit-only',watch_scope_json:'["assertions"]',required_skills:[{name:'skr-audit-evidence',version:'1'}],lifecycle:'draft',validation:'unreviewed',active:false};else if(req.includes('proposals'))output={proposals:[],subgoals:[],uncertainties:[]};else if(req.includes('assertions'))output={assertions:[]};else if(req.includes('reviews'))output={reviews:[]};else if(req.includes('repairs'))output={repairs:[]};else if(req.includes('relations'))output={relations:[]};else if(req.includes('findings'))output={findings:[],coverage:{regionsConsidered:0}};else if(req.includes('answer'))output={answer:'No supported source facts were found.',claims:[],citationIds:[],supportState:'unresolved',residuals:['No supported evidence']};else if(req.includes('goal')&&req.includes('scope'))output={goal:'',scope:zeroScope,reasoningNotes:'No source vocabulary available.'};else throw new Error(`No fake output for required fields ${req.join(',')}`);return{output,sessionId:'api-test-session',usage:{input_tokens:1,output_tokens:1},wallMs:1}}};

test('service HTTP task API completes all six dispatched task types under injected runner',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'skr-api-tasks-'));
 const runner={async run(args){return dispatchTask({...args,session,checkpointDir:join(args.workspaceDir,'checkpoints')})}};
 const app=createApp({dataDir,runner,trustedLocal:true}),address=await app.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${address.port}`;
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true})});
 const api=async(path,method='GET',body)=>{const response=await fetch(base+'/api'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()}};
 const project=(await api('/projects','POST',{name:'All task types'})).data.project,snapshot=(await app.store.getSnapshot(project.id));
 const source=(await api(`/projects/${project.id}/sources`,'POST',{name:'tiny.ske',mimeType:'text/plain',content:Buffer.from('(holds entity:test property:available)').toString('base64')})).data.source;
 const proc=snapshot.procedures.find(p=>p.active!==false);
 const requests=[
  {type:'QUESTION',text:'Is the test entity available?',sourceScope:[source.sourceVersionId]},
  {type:'INGEST_SOURCE',text:'Extract supported assertions from the selected source.',sourceScope:[source.sourceVersionId]},
  {type:'APPLY_PROCEDURE',text:'Apply the selected method.',procedureId:proc.id,procedureVersion:proc.version,parameters:{},sourceScope:[source.sourceVersionId]},
  {type:'BUILD_PROCEDURE',text:'Draft a source evidence review procedure.',sourceScope:[source.sourceVersionId]},
  {type:'AUDIT_PROJECT',text:'Audit in-scope claims.',sourceScope:[source.sourceVersionId]},
  {type:'EVALUATE',text:'Evaluate the frozen controlled fixture.',fixturePath:'fixtures/controlled.json',baselines:['skr-direct'],sourceScope:[source.sourceVersionId]}
 ];
 for(const request of requests){
  const started=await api(`/projects/${project.id}/requests`,'POST',request);assert.equal(started.status,202,`${request.type}: ${JSON.stringify(started.data)}`);
  let run;for(let i=0;i<300;i++){run=(await api(`/runs/${started.data.runId}`)).data.run;if(['completed','failed','cancelled'].includes(run.status))break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(run.status,'completed',`${request.type}: ${run.error??'run timeout'}`);assert.equal(run.execution,'test-injected-runner');assert.equal(run.result.answerPackage.snapshotId,run.snapshotId);assert.ok(run.result.validation);assert.equal(run.type,request.type);
 }
});
