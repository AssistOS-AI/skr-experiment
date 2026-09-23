import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.mjs';
import { parseSKE } from '../src/engine/index.mjs';

const dataDir=await mkdtemp(join(tmpdir(),'skr-demo-'));
const app=createApp({dataDir,runnerMode:'reference',trustedLocal:true});
try {
  const address=await app.listen(0,'127.0.0.1'); const base=`http://127.0.0.1:${address.port}/api`;
  const request=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw Error(d.error);return d;};
  const store=app.store;
  const created=await request('/projects','POST',{name:'SKR Literary Analysis Base'}),baseProject=created.project;
  await store.commit(baseProject.id,created.snapshot.id,{policy:{autoCommit:false}});
  const baseSnapshot=(await store.getSnapshot(baseProject.id)).id;
  const a=(await request(`/projects/${baseProject.id}/fork`,'POST',{snapshotId:baseSnapshot,name:'Book A'})).project;
  const b=(await request(`/projects/${baseProject.id}/fork`,'POST',{snapshotId:baseSnapshot,name:'Book B'})).project;
  const text='(depends_on service:payment service:identity)\n(located_in service:identity region:eu)\n';
  const {source,snapshot}=await store.registerSource(a.id,{name:'book-a-notes.ske',content:Buffer.from(text),mimeType:'text/plain'});
  const records=source.regions.map((region,index)=>({id:`assertion_${index+1}`,type:'assertion',ske:parseSKE(region.text),sourceVersionId:source.sourceVersionId,sourceId:source.sourceId,regionId:region.id,quote:region.text,lifecycle:'current'}));
  await store.commit(a.id,snapshot.id,{records});
  await store.registerSource(b.id,{name:'book-b-notes.txt',content:Buffer.from('A separate project source.'),mimeType:'text/plain'});
  console.log(`Created reusable project ${baseProject.id}, fork ${a.id}, and independent fork ${b.id}.`);
  const run=await request(`/projects/${a.id}/requests`,'POST',{type:'QUESTION',text:'(find (?service) (and (depends_on service:payment ?service) (located_in ?service region:eu)))',sourceScope:[source.sourceVersionId]});
  let result;
  for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,100));result=(await request(`/runs/${run.runId}`)).run;if(['completed','failed','cancelled'].includes(result.status))break;}
  if(result.status!=='completed')throw Error(`Demo run ${result.status}: ${result.error||''}`);
  const ap=result.result.answerPackage; if(ap.supportState!=='supported'||!ap.answer.includes('service:identity')||!result.result.evidence.length) throw Error(`Join not proven: ${JSON.stringify(ap)}`);
  console.log(JSON.stringify({runner:result.execution,answer:ap.answer,support:ap.supportState,evidence:result.result.evidence.map(e=>({type:e.type,sourceVersionId:e.sourceVersionId,regionId:e.regionId,quote:e.quote}))},null,2));
} finally { await new Promise(r=>app.server.close(r)); await rm(dataDir,{recursive:true,force:true}); }
