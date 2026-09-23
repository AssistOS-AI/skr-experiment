import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { parseSKE } from '../src/engine/index.mjs';

async function withServer(t,options={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'skr-server-test-')); const app=createApp({dataDir,runnerMode:'reference',trustedLocal:true,...options});
  const addr=await app.listen(0,'127.0.0.1'); const base=`http://127.0.0.1:${addr.port}`;
  t.after(async()=>{await new Promise(r=>app.server.close(r));await rm(dataDir,{recursive:true,force:true});});
  return {app,base,api:async(path,method='GET',body)=>{const res=await fetch(base+'/api'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await res.json();return {status:res.status,data};}};
}
async function waitFor(api,id){for(let i=0;i<100;i++){const {data}=await api(`/runs/${id}`);if(['completed','failed','cancelled'].includes(data.run.status))return data.run;await new Promise(r=>setTimeout(r,25));}throw Error('run timeout');}

test('HTTP project upload and question returns reopenable scoped evidence; codex is the production default',async t=>{
 const {app,api,base}=await withServer(t);const status=(await api('/status')).data;assert.deepEqual(status,{runner:'deterministic-reference',execution:'reference',configuredModel:null,model:null});
 const created=await api('/projects','POST',{name:'Book'});assert.equal(created.status,201);const id=created.data.project.id;
 const source=(await api(`/projects/${id}/sources`,'POST',{name:'evidence.txt',mimeType:'text/plain',content:Buffer.from('(depends_on service:payment service:identity)\n(located_in service:identity region:eu)').toString('base64')})).data.source;
 const inspect=await api(`/projects/${id}/sources/${source.sourceVersionId}`);assert.equal(inspect.data.source.regions.length,2);const region=inspect.data.source.regions[0];assert.equal((await api(`/projects/${id}/sources/${source.sourceVersionId}/regions/${region.id}`)).data.region.text,region.text);const original=await api(`/projects/${id}/sources/${source.sourceVersionId}/original`);assert.equal(Buffer.from(original.data.contentBase64,'base64').toString().includes('depends_on'),true);assert.equal((await api(`/projects/${id}/export?snapshotId=${source.sourceVersionId}`)).status,400);assert.equal((await api(`/projects/${id}/export?snapshotId=${(await app.store.getSnapshot(id)).id}`)).data.format,'skr-project-export-v1');
 let uploadSnapshot=await app.store.getSnapshot(id);const replacement=await api(`/projects/${id}/sources`,'POST',{name:'evidence-v2.txt',sourceId:source.sourceId,expectedSnapshotId:uploadSnapshot.id,mimeType:'text/plain',content:Buffer.from('replacement text').toString('base64')});assert.equal(replacement.status,201);assert.equal(replacement.data.source.sourceId,source.sourceId);assert.notEqual(replacement.data.source.sourceVersionId,source.sourceVersionId);assert.equal((await api(`/projects/${id}/sources/${source.sourceVersionId}`)).status,404);
 // Reupload the exact source under its version so this question pins the current source regions.
 const source2=(await api(`/projects/${id}/sources`,'POST',{name:'evidence.txt',mimeType:'text/plain',content:Buffer.from('(depends_on service:payment service:identity)\n(located_in service:identity region:eu)').toString('base64')})).data.source;
 let snap=await app.store.getSnapshot(id);await app.store.commit(id,snap.id,{records:source2.regions.map((r,i)=>({id:`fact_${i}`,ske:parseSKE(r.text),sourceVersionId:source2.sourceVersionId,sourceId:source2.sourceId,regionId:r.id,lifecycle:'current'}))});
 const submitted=await api(`/projects/${id}/requests`,'POST',{type:'QUESTION',text:'(find (?service) (and (depends_on service:payment ?service) (located_in ?service region:eu)))',sourceScope:[source2.sourceVersionId]});assert.equal(submitted.status,202);
 const run=await waitFor(api,submitted.data.runId);assert.equal(run.status,'completed');assert.equal(run.execution,'reference');assert.equal(run.result.answerPackage.supportState,'supported');assert.equal(run.result.validation.audit.status,'valid');assert.equal(run.result.evidence.length,2);
 const cross=await fetch(base+'/api/projects',{method:'POST',headers:{origin:'https://attacker.example','content-type':'application/json'},body:JSON.stringify({name:'denied'})});assert.equal(cross.status,403);
 const crossFetch=await fetch(base+'/api/projects',{method:'POST',headers:{'sec-fetch-site':'cross-origin','content-type':'application/json'},body:JSON.stringify({name:'denied'})});assert.equal(crossFetch.status,403);
 const scopeErr=await api(`/projects/${id}/requests`,'POST',{type:'QUESTION',text:'anything',sourceScope:['srcv_foreign']});assert.equal(scopeErr.status,400);
 assert.equal((await api('/status')).data.model,null);
});

test('cancelled coding runner cannot publish and gets an honest status',async t=>{
 let started;const start=new Promise(r=>started=r);const runner={async run({signal}){started();await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,150);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason)},{once:true})});return {answerPackage:{answer:'x',claims:[],supportState:'unsupported',snapshotId:'x'},evidence:[]}}};
 const {api}=await withServer(t,{runner});const p=(await api('/projects','POST',{name:'Cancel'})).data.project;
 const request=await api(`/projects/${p.id}/requests`,'POST',{type:'QUESTION',text:'x'});await start;assert.equal((await api(`/runs/${request.data.runId}/cancel`,'POST')).status,202);
 const run=await waitFor(api,request.data.runId);assert.equal(run.status,'cancelled');assert.equal(run.result,undefined);
});

test('Codex Luna is the default production adapter and is never silently replaced',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'skr-default-'));const app=createApp({dataDir});
 t.after(async()=>{await new Promise(r=>app.server.close(r));await rm(dataDir,{recursive:true,force:true});});
 assert.equal(app.runner.constructor.name,'CodexLunaRunner');
});
