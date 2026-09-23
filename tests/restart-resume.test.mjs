import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';

async function post(base,path,body){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,payload:await r.json()}}
async function wait(base,id){for(let n=0;n<100;n++){const r=await fetch(`${base}/api/runs/${id}`),{run}=await r.json();if(['completed','failed'].includes(run.status))return run;await new Promise(ok=>setTimeout(ok,10))}throw new Error('Run did not finish')}

test('interrupted run resumes under its original id, workspace, request and pinned snapshot',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'skr-resume-'));let calls=0,extraSkillLinked=false;const runner={async run({snapshot,workspaceDir}){calls++;try{await import('node:fs/promises').then(fs=>fs.lstat(join(workspaceDir,'skills','skr-context-pass')));extraSkillLinked=true}catch{}return{answerPackage:{answer:`turn ${calls}`,claims:[],snapshotId:snapshot.id,supportState:'unresolved'},evidence:[]}}};
 let app=createApp({dataDir,runner,trustedLocal:true});let addr=await app.listen(0),base=`http://127.0.0.1:${addr.port}`;
 try{
  const p=await post(base,'/api/projects',{name:'Resume'}),projectId=p.payload.project.id;
  const launched=await post(base,`/api/projects/${projectId}/requests`,{type:'QUESTION',text:'remember this',sourceScope:[]});const run=await wait(base,launched.payload.runId);assert.equal(run.status,'completed');const pinned=run.snapshotId,workspace=run.workspaceDir;
  run.status='interrupted';delete run.result;await app.store.saveRun(run);await new Promise(ok=>app.server.close(ok));
  app=createApp({dataDir,runner,trustedLocal:true});addr=await app.listen(0);base=`http://127.0.0.1:${addr.port}`;
  const bundle=[...run.skillBundle,{name:'skr-context-pass',version:'1'}];const linked=await post(base,`/api/runs/${run.id}/skills/link`,{bundle});assert.equal(linked.status,200);if(run.sessionId)assert.equal(linked.payload.sessionId,run.sessionId);
  const resumed=await post(base,`/api/runs/${run.id}/resume`,{});assert.equal(resumed.status,202);assert.equal(resumed.payload.runId,run.id);
  const complete=await wait(base,run.id);assert.equal(complete.status,'completed');assert.equal(complete.id,run.id);assert.equal(complete.snapshotId,pinned);assert.equal(complete.workspaceDir,workspace);assert.equal(complete.request.text,'remember this');assert.equal(calls,2);assert.ok(extraSkillLinked);assert.ok(complete.skillBundle.some(x=>x.name==='skr-context-pass'));
 }finally{await new Promise(ok=>app.server.close(ok));await rm(dataDir,{recursive:true,force:true})}
});
