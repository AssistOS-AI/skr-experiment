import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.mjs';

test('projects seed canonical procedures and manager activates an exact draft version',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'skr-procedure-approval-')),app=createApp({dataDir,runnerMode:'reference'}),addr=await app.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${addr.port}`;
 t.after(async()=>{await new Promise(r=>app.server.close(r));await rm(dataDir,{recursive:true,force:true})});
 const call=async(path,method='GET',body,token)=>{const headers={};if(body!==undefined)headers['content-type']='application/json';if(token)headers.authorization=`Bearer ${token}`;const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json()}};
 const bootstrapToken=(await readFile(join(dataDir,'auth','bootstrap.token'),'utf8')).trim(),login=await call('/api/auth/bootstrap','POST',{username:'method_owner',password:'long-procedure-password',bootstrapToken});assert.equal(login.status,201);const token=login.body.token,created=await call('/api/projects','POST',{name:'Methods'},token),id=created.body.project.id;
 const initial=await call(`/api/projects/${id}`,'GET',undefined,token),snap=initial.body.snapshot;for(const key of ['contradiction-audit@1.0.0','relevance-synthesis@1.0.0','document-literary-rubric@1.0.0'])assert.ok(snap.procedures.some(p=>`${p.id}@${p.version}`===key&&p.active));
 const previous=snap.procedures.find(p=>p.id==='contradiction-audit'&&p.version==='1.0.0');await app.store.commit(id,snap.id,{records:[{id:'finding_old',type:'procedure-finding',procedureId:previous.id,procedureVersion:previous.version,lifecycle:'current',supportState:'unresolved'}]});let head=await app.store.getSnapshot(id);
 const draft={...previous,version:'1.0.1',active:false,lifecycle:'draft',validation:'unreviewed'};delete draft.review;delete draft.approval;delete draft.activation;const staged=await app.store.commit(id,head.id,{procedures:[draft]});assert.equal(staged.procedures.find(p=>p.version==='1.0.0').active,true);assert.equal(staged.records.find(r=>r.id==='finding_old').lifecycle,'current');
 const approved=await call(`/api/projects/${id}/procedures/contradiction-audit/approve`,'POST',{version:'1.0.1',expectedSnapshotId:staged.id},token);assert.equal(approved.status,200);assert.equal(approved.body.procedure.version,'1.0.1');assert.equal(approved.body.procedure.activation.reviewedBy,'method_owner');assert.equal(approved.body.snapshot.procedures.find(p=>p.version==='1.0.0').active,false);assert.equal(approved.body.snapshot.records.find(r=>r.id==='finding_old').lifecycle,'stale');
});
