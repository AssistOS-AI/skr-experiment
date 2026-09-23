import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';

test('bootstrap, login, project membership, fork capability, and cross-user run/project isolation',async()=>{
 let calls=0;const dataDir=await mkdtemp(join(tmpdir(),'skr-auth-'));const app=createApp({dataDir,runner:{async run({snapshot}){calls++;return{answerPackage:{answer:'private result',claims:[],snapshotId:snapshot.id,supportState:'unresolved'},evidence:[]}}}});const address=await app.listen(0),base=`http://127.0.0.1:${address.port}`;
 const call=async(path,method='GET',body,token)=>{const headers={};if(body!==undefined)headers['content-type']='application/json';if(token)headers.authorization=`Bearer ${token}`;const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,payload:await response.json()}};
 try{
  assert.equal((await call('/api/projects')).status,401);
  const bootstrapToken=(await readFile(join(dataDir,'auth','bootstrap.token'),'utf8')).trim();
  const a=await call('/api/auth/bootstrap','POST',{username:'alice',password:'long-test-password-1',bootstrapToken});assert.equal(a.status,201);
  const alice=a.payload.token;const created=await call('/api/projects','POST',{name:'Alice project'},alice);assert.equal(created.status,201);const projectId=created.payload.project.id;
  const upload=await call(`/api/projects/${projectId}/sources`,'POST',{name:'private.txt',mimeType:'text/plain',content:Buffer.from('private source').toString('base64')},alice);assert.equal(upload.status,201);
  const sourceId=upload.payload.source.sourceVersionId;
  const catalog=await call(`/api/projects/${projectId}/skills?type=QUESTION`,'GET',undefined,alice),bundle=catalog.payload.required;
  assert.equal((await call(`/api/projects/${projectId}/skills/request`,'POST',{bundle,taskType:'QUESTION'},alice)).status,200);
  assert.equal((await call(`/api/projects/${projectId}/skills/approve`,'POST',{},alice)).status,200);
  const req=await call(`/api/projects/${projectId}/requests`,'POST',{type:'QUESTION',text:'private question',sourceScope:[sourceId]},alice);assert.equal(req.status,202);let run;
  for(let i=0;i<50;i++){run=(await call(`/api/runs/${req.payload.runId}`,'GET',undefined,alice)).payload.run;if(['completed','failed'].includes(run.status))break;await new Promise(r=>setTimeout(r,10))}assert.equal(run.status,'completed');assert.equal(calls,1);
  const b=await call('/api/auth/users','POST',{username:'bob',password:'long-test-password-2'},alice);assert.equal(b.status,201);const bob=b.payload.token;
  assert.equal((await call('/api/projects', 'GET',undefined,bob)).payload.projects.length,0);
  assert.equal((await call(`/api/projects/${projectId}`,'GET',undefined,bob)).status,404);
  assert.equal((await call(`/api/projects/${projectId}/snapshot?id=${upload.payload.snapshot.id}`,'GET',undefined,bob)).status,404);
  assert.equal((await call(`/api/projects/${projectId}/sources`,'POST',{name:'intrusion',content:'x'},bob)).status,404);
  assert.equal((await call(`/api/runs/${run.id}`,'GET',undefined,bob)).status,404);
  assert.equal((await call(`/api/runs/${run.id}/explain`,'GET',undefined,bob)).status,404);
  assert.equal((await call(`/api/runs/${run.id}/publish`,'POST',{},bob)).status,404);
  assert.equal((await call(`/api/runs/${run.id}/cancel`,'POST',{},bob)).status,404);
  assert.equal((await call(`/api/projects/${projectId}/fork`,'POST',{name:'forbidden fork'},bob)).status,404);
  assert.equal((await call(`/api/projects/${projectId}/members`,'POST',{username:'bob',capabilities:['read','fork']},alice)).status,200);
  assert.equal((await call(`/api/projects/${projectId}`,'GET',undefined,bob)).status,200);
  const fork=await call(`/api/projects/${projectId}/fork`,'POST',{name:'Bob fork'},bob);assert.equal(fork.status,201);const childId=fork.payload.project.id;
  const parentNext=await call(`/api/projects/${projectId}/sources`,'POST',{name:'later.txt',mimeType:'text/plain',content:Buffer.from('new parent content').toString('base64')},alice);assert.equal(parentNext.status,201);
  assert.equal((await call(`/api/projects/${childId}/rebase`,'POST',{newParentSnapshotId:parentNext.payload.snapshot.id},bob)).status,200);
  await call(`/api/projects/${projectId}/members`,'POST',{username:'bob',capabilities:[]},alice);
  const parentCurrent=await call(`/api/projects/${projectId}`,'GET',undefined,alice);
  assert.equal((await call(`/api/projects/${childId}/rebase`,'POST',{newParentSnapshotId:parentCurrent.payload.snapshot.id},bob)).status,404);
  await call(`/api/projects/${projectId}/members`,'POST',{username:'bob',capabilities:[]},alice);
  assert.equal((await call(`/api/projects/${projectId}`,'GET',undefined,bob)).status,404);
  assert.equal((await call('/api/auth/logout','POST',{},bob)).status,200);
  assert.equal((await call('/api/projects','GET',undefined,bob)).status,401);
 } finally {await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true})}
});

test('one bootstrap wins, parallel ACL grants preserve both project memberships',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'skr-auth-race-')),app=createApp({dataDir,runnerMode:'reference'});await app.listen(0);
 try{const token=(await readFile(join(dataDir,'auth','bootstrap.token'),'utf8')).trim();const results=await Promise.allSettled([app.auth.bootstrap({username:'owner',password:'long-password-aaa',bootstrapToken:token}),app.auth.bootstrap({username:'owner2',password:'long-password-bbb',bootstrapToken:token})]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);const owner=results.find(x=>x.status==='fulfilled').value.user;const member1=await app.auth.createUser({username:'member1',password:'long-password-ccc'}),member2=await app.auth.createUser({username:'member2',password:'long-password-ddd'});await app.auth.createProject(owner,'proj_one');await Promise.all([app.auth.grantMember(owner,'proj_one','member1',['read']),app.auth.grantMember(owner,'proj_one','member2',['read'])]);const state=JSON.parse(await readFile(join(dataDir,'auth','project-acl.json'),'utf8'));assert.equal(Object.keys(state.projects.proj_one).length,3);assert.ok(member1.token&&member2.token)}finally{await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true})}
});
