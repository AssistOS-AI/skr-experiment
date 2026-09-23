import http from 'node:http';
import { extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, symlink, lstat, copyFile, chmod } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from './store.mjs';
import { DeterministicRunner, CodexLunaRunner, CODING_AGENT_MODEL } from './runtime/runners.mjs';
import * as engine from './engine/index.mjs';
import { CodexLunaSession } from './runtime/session.mjs';
import { dispatchTask } from './runtime/task-dispatch.mjs';
import { AuthManager } from './auth/auth.mjs';
import { SkillRegistry, SKILL_TASKS, CORE_SKILL } from './runtime/skills.mjs';
import { aggregateChildAccounting } from './runtime/run-accounting.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TASKS = new Set(['QUESTION','INGEST_SOURCE','APPLY_PROCEDURE','BUILD_PROCEDURE','AUDIT_PROJECT','EVALUATE']);
const SKILLS=SKILL_TASKS;
const STANDARD_PROCEDURES= Object.values(engine.procedureDefinitions()).map(def=>({...def,name:def.id.replaceAll('-',' ').replace(/\b\w/g,x=>x.toUpperCase()),ordered_steps:def.orderedSteps,evidence_obligations:def.evidenceObligations,output_schema:{type:'array',items:{type:'object'}},required_skills:[{name:'skr-procedure-apply',version:'1'},{name:'skr-audit-evidence',version:'1'}],active:true,lifecycle:'current',validation:'shipped-reviewed',review:{state:'shipped-method',reviewedAt:'2026-09-23'}}));
async function safeWorkspaceWrite(root,subdir,name,data) { const dir=join(root,subdir); const st=await lstat(dir); if(!st.isDirectory()||st.isSymbolicLink()) throw new Error('Unsafe workspace artifact directory'); const dest=join(dir,name); try { const prior=await lstat(dest); if(prior.isSymbolicLink()||!prior.isFile()) throw new Error('Unsafe workspace artifact path'); throw new Error('Workspace artifact already exists'); } catch(e) { if(e.code!=='ENOENT') throw e; } await writeFile(dest,data,{flag:'wx',mode:0o600}); }
const sendJson = (res, status, data) => { const body=JSON.stringify(data); res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body)}); res.end(body); };
async function bodyJson(req, max=48_000_000) { let s=''; for await (const c of req) { s+=c; if(Buffer.byteLength(s)>max) throw Object.assign(new Error('Request too large'),{status:413}); } try{return s?JSON.parse(s):{};}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});} }
function safeId(s){ return typeof s==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(s); }
function requiredProcedureSkills(proc){return (proc?.required_skills??[]).map(x=>typeof x==='string'?(()=>{const [name,version='1']=x.split('@');return {name,version}})():x)}
function requiredSkillsForTask(snapshot,type,selectedProcedure){const procedures=type==='INGEST_SOURCE'?(snapshot.procedures??[]).filter(p=>p.active!==false&&(p.materialization_policy??p.materializationPolicy)==='on-ingestion'):(selectedProcedure?[selectedProcedure]:[]);return [...new Map(procedures.flatMap(requiredProcedureSkills).map(skill=>[`${skill.name}@${skill.version}`,skill])).values()]}

export function createApp({ dataDir=resolve(process.cwd(),'data'), runner, runnerMode='codex-luna', timeoutMs, trustedLocal=false, sessionFactory=options=>new CodexLunaSession(options) }={}) {
  const store = new ProjectStore({rootDir:dataDir});
  const auth = new AuthManager(dataDir);
  const skillRegistry=new SkillRegistry({rootDir:dataDir,skillsRoot:join(ROOT,'skills')});
  const chosenRunner = runner ?? (runnerMode==='reference' ? new DeterministicRunner({engine}) : new CodexLunaRunner({timeoutMs}));
  const active = new Map();
  async function prepareWorkspace(runId, req, snapshot, sourceScope, dir, resume=false) {
    await mkdir(dir,{recursive:true});
    for(const name of ['work','state','out','events']) await mkdir(join(dir,name),{recursive:true});
    const writePinned=async(file,data)=>{try{const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink())throw new Error(`Unsafe pinned workspace input: ${file}`);await chmod(file,0o600);await writeFile(file,data)}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(file,data,{flag:'wx',mode:0o400})}};
    await writePinned(join(dir,'request.json'),JSON.stringify({runId,taskType:req.type,text:req.text,sourceScope,snapshotId:snapshot.id,procedureId:req.procedureId,procedureVersion:req.procedureVersion,parameters:req.parameters??{},createdAt:new Date().toISOString()},null,2));
    const selected=snapshot.sources.filter(s=>sourceScope.includes(s.id)||sourceScope.includes(s.sourceVersionId));
    const selectedIds=new Set(selected.flatMap(s=>[s.id,s.sourceVersionId,s.sourceId]));
    const byId=new Map((snapshot.records??[]).map(r=>[r.id,r]));
    const safeRecord=(record,seen=new Set())=>{
      if(seen.has(record.id)) return false;
      const deps=[...(record.dependencies??[]),...(record.premiseIds??[]),...(record.evidenceIds??[])];
      if((record.sourceVersionId||record.sourceId)&&!(selectedIds.has(record.sourceVersionId)||selectedIds.has(record.sourceId))) return false;
      if(deps.length&& !deps.every(id=>{if(selectedIds.has(id))return true;const dep=byId.get(id);return dep?safeRecord(dep,new Set([...seen,record.id])):false})) return false;
      if(record.sourceVersionId||record.sourceId||deps.length) return true;
      return true;
    };
    const allowedRecords=(snapshot.records??[]).filter(r=>safeRecord(r));
    const scopedSnapshot={id:snapshot.id,projectId:snapshot.projectId,parentSnapshotId:snapshot.parentSnapshotId,sources:selected,records:allowedRecords,rules:(snapshot.rules??[]).filter(r=>safeRecord(r)),procedures:snapshot.procedures??[],policy:snapshot.policy??{},coverage:(snapshot.coverage??[]).filter(c=>selectedIds.has(c.sourceVersionId)),versionMetadata:snapshot.versionMetadata??{}};
    await writePinned(join(dir,'snapshot.json'),JSON.stringify(scopedSnapshot,null,2));
    await mkdir(join(dir,'sources'),{recursive:true});
    for(const source of snapshot.sources.filter(s=>sourceScope.includes(s.id)||sourceScope.includes(s.sourceVersionId))) {
      const bytes=await store.readSource(source.sourceVersionId??source.id); const name=`${source.id}-${basename(source.name).replace(/[^A-Za-z0-9._-]/g,'_')}`;
      await writePinned(join(dir,'sources',name),bytes);
    }
    const approvedSkills=join(dataDir,'sessions',runId,'approved-skills'); await mkdir(approvedSkills,{recursive:true,mode:0o700}); await mkdir(join(dir,'skills'),{recursive:true});
    for(const {name,version='1'} of req.skillBundle??[{name:CORE_SKILL,version:'1'},...(SKILLS[req.type]??[]).map(name=>({name,version:'1'}))]) {
      const source=resolve(ROOT,'skills',name,version); const mount=join(approvedSkills,name,version); await mkdir(mount,{recursive:true,mode:0o700});
      for(const file of ['SKILL.md']) { const from=join(source,file); const to=join(mount,file); if(resume){try{const prior=await readFile(to);const current=await readFile(from);if(!prior.equals(current))throw new Error('Approved skill bundle changed since the run was pinned')}catch(error){if(error.code!=='ENOENT')throw error;await copyFile(from,to);await chmod(to,0o444)}}else{await copyFile(from,to);await chmod(to,0o444)} }
      const expected=req.skillBundle.find(x=>x.name===name&&x.version===version)?.digest;if(expected&&createHash('sha256').update(await readFile(join(mount,'SKILL.md'))).digest('hex')!==expected)throw new Error(`Skill ${name}@${version} changed after approval`);
      const linkPath=join(dir,'skills',name),target=chosenRunner instanceof DeterministicRunner?source:`/skr/skills/${name}/${version}`;
      if(resume){try{const existing=await lstat(linkPath);if(!existing.isSymbolicLink())throw new Error('Unsafe skill link in resumable workspace');const {readlink,unlink}=await import('node:fs/promises');if(await readlink(linkPath)!==target)throw new Error('Resumable skill link changed');}catch(error){if(error.code!=='ENOENT')throw error;await symlink(target,linkPath,'dir')}}else await symlink(target,linkPath,'dir');
    }
    return {skillsDir:approvedSkills,sessionDir:join(dataDir,'sessions',runId)};
  }
  function validateBundle(bundle, snapshot, sourceScope) {
    const ap=bundle?.answerPackage;
    if(!ap || typeof ap.answer!=='string' || !Array.isArray(bundle.evidence)) throw new Error('Malformed agent output bundle');
    if(ap.snapshotId!==snapshot.id) throw new Error('Output snapshot does not match pinned snapshot');
    const allowed=new Map();
    for(const source of snapshot.sources) if(sourceScope.includes(source.id)||sourceScope.includes(source.sourceVersionId)) for(const region of source.regions??[]) allowed.set(`${source.sourceVersionId??source.id}:${region.id}`,{source,region});
    const evidenceIds=new Set((bundle.evidence??[]).map(x=>x?.id).filter(Boolean));
    for(const item of bundle.evidence) {
      if(!item||typeof item.id!=='string') throw new Error('Evidence entries require IDs');
      if(item.type==='source' || item.sourceVersionId) {
        const pair=allowed.get(`${item.sourceVersionId}:${item.regionId}`); if(!pair) throw new Error('Evidence references a source outside the authorized scope or snapshot');
        if(typeof item.quote!=='string' || !pair.region.text.includes(item.quote)) throw new Error('Evidence quote does not reopen exactly in its pinned source region');
      } else if(item.type==='derived') {
        if(!Array.isArray(item.premiseIds)||item.premiseIds.some(id=>!evidenceIds.has(id))) throw new Error('Derived evidence must reference prior evidence in the bundle');
      }
    }
    for(const claim of ap.claims??[]) if(!Array.isArray(claim.evidenceIds)||claim.evidenceIds.some(id=>!evidenceIds.has(id))) throw new Error('Claim references missing evidence');
    return {state:'validated-structure-and-scope',semanticAudit:ap.supportState??'unverified'};
  }
  async function recoverRuns(){
    await store.ready;
    const {readdir}=await import('node:fs/promises');
    for(const name of await readdir(store.runsDir)){if(!name.endsWith('.json'))continue;const run=await store.getRun(name.slice(0,-5)).catch(()=>null);if(!run)continue;
      if(['queued','running'].includes(run.status)){run.status='interrupted';run.interruptedAt=new Date().toISOString();await store.saveRun(run)}
      else if(run.status==='publishing'){run.status='publication-uncertain';run.error='Server stopped during publication; automatic retry is disabled to prevent duplicate commit.';run.interruptedAt=new Date().toISOString();await store.saveRun(run)}
    }
  }
  async function launch(projectId, request, resumeRun=null) {
    const snapshot=await store.getSnapshot(projectId,request.snapshotId);
    if(!snapshot) throw new Error('Snapshot not found');
    const proc=snapshot.procedures.find(p=>p.id===request.procedureId&&String(p.version)===String(request.procedureVersion));
    const requiredSkills=requiredSkillsForTask(snapshot,request.type,proc);
    const selectedBundle=await skillRegistry.assertApproved(projectId,request.type,request.skillBundle,requiredSkills);
    request={...request,skillBundle:selectedBundle};
    const requested=request.sourceScope ?? snapshot.sources.map(s=>s.sourceVersionId??s.id);
    if(!Array.isArray(requested)||requested.some(id=>!snapshot.sources.some(s=>(s.id===id||s.sourceVersionId===id)))) throw new Error('Source scope contains a source outside this project snapshot');
    const sourceScope=[...new Set(requested)]; const runId=resumeRun?.id??`run_${randomUUID().replaceAll('-','')}`;
    const workspaceDir=resumeRun?.workspaceDir??join(dataDir,'workspaces',runId); const controller=new AbortController(); const run=resumeRun??{id:runId,projectId,type:request.type,skillBundle:selectedBundle,model:null,configuredModel:chosenRunner instanceof DeterministicRunner?null:CODING_AGENT_MODEL,execution:chosenRunner instanceof DeterministicRunner?'reference':chosenRunner instanceof CodexLunaRunner?'pending':'test-injected-runner',snapshotId:snapshot.id,sourceScope,createdAt:new Date().toISOString(),events:[],workspaceDir};
    run.type=request.type;run.request=structuredClone(request);run.sourceScope=sourceScope;run.status='queued';run.error=undefined;run.result=undefined;run.completedAt=undefined;
    active.set(runId,{controller,run}); let saveChain=Promise.resolve(); const persist=()=>{saveChain=saveChain.then(()=>store.saveRun(structuredClone(run))); return saveChain;}; await persist();
    void (async()=>{
      const event=(e)=>{run.events.push(e); void persist();};
      try {
        run.status='running'; await persist(); event({type:'run.started',at:new Date().toISOString(),snapshotId:snapshot.id});
        const prepared=await prepareWorkspace(runId,request,snapshot,sourceScope,workspaceDir,Boolean(resumeRun));
        let result;
        if(chosenRunner instanceof DeterministicRunner || !(chosenRunner instanceof CodexLunaRunner)) {result=await chosenRunner.run({request,snapshot,sourceScope,workspaceDir,signal:controller.signal,onEvent:event});if(!(chosenRunner instanceof DeterministicRunner))run.execution='test-injected-runner'}
        else {
          const session=sessionFactory({workspaceDir,timeoutMs,isolation:{enabled:true,sessionDir:prepared.sessionDir,skillsDir:prepared.skillsDir}});
          const sessionEvent=(e)=>{if(e.sessionId){run.sessionId=e.sessionId;run.execution='actual-coding-agent';run.model=CODING_AGENT_MODEL}if(e.type==='codex.turn.completed'&&e.usage)run.cumulativeUsage=e.usage;event(e);};
          session.onEvent=sessionEvent;
          result=await dispatchTask({request,snapshot,sourceScope,session,workspaceDir,checkpointDir:join(prepared.sessionDir,'checkpoints'),signal:controller.signal,onEvent:sessionEvent,store});
          const sessionStatus=await session.status(); run.sessionId=sessionStatus.sessionId;run.usageLedger=sessionStatus.usageLedger;run.usage=sessionStatus.totalUsage;run.sessionRequests=sessionStatus.requests;
          const childRows=result.report?.rows??[],childAccounting=aggregateChildAccounting(childRows);
          if(childAccounting.sessionIds.length){run.model=CODING_AGENT_MODEL;run.execution='actual-coding-agent';run.childSessionIds=childAccounting.sessionIds;run.usage=childAccounting.usage;run.usageLedger=childAccounting.usageLedger;run.usageAccounting=childAccounting.accounting;run.sessionRequests=childAccounting.requests}else if(!sessionStatus.requests){run.model=null;run.execution='deterministic-service'}
        }
        if(controller.signal.aborted) throw new Error('Run cancelled');
        const validation=validateBundle(result,snapshot,sourceScope);
        if(result.changeSet!==undefined) { const {validateChangeSet}=await import('./runtime/change-validation.mjs'); const trustedReceipts=chosenRunner instanceof CodexLunaRunner?result.reviewReceipts??[]:[]; result.changeSet=validateChangeSet({changeSet:result.changeSet,taskType:request.type,snapshot,sourceScope,evidence:result.evidence,reviewReceipts:trustedReceipts});run.reviewReceipts=trustedReceipts;delete result.reviewReceipts; }
        let auditSnapshot=snapshot,runLocalRecords=[],semanticRecords=[],semanticReceipts=[],procedureReceipts=[];
        if(request.type==='QUESTION'&&chosenRunner instanceof CodexLunaRunner&&(result.ephemeralRecords||result.candidates)&&Array.isArray(result.reviewReceipts)) {const {validateChangeSet}=await import('./runtime/change-validation.mjs');semanticReceipts=result.reviewReceipts;semanticRecords=validateChangeSet({changeSet:{records:result.ephemeralRecords??result.candidates},taskType:'INGEST_SOURCE',snapshot,sourceScope,evidence:[],reviewReceipts:semanticReceipts}).records;auditSnapshot={...snapshot,records:[...(snapshot.records??[]),...semanticRecords]};result.validation={...result.validation,ephemeralReviewedRecords:semanticRecords.length,ephemeralNotCommitted:true};delete result.ephemeralRecords;delete result.candidates;delete result.reviewReceipts;}
        if(request.type==='QUESTION'&&chosenRunner instanceof CodexLunaRunner&&Array.isArray(result.runLocalProcedureRecords)&&Array.isArray(result.procedureReviewReceipts)){const {validateChangeSet}=await import('./runtime/change-validation.mjs');procedureReceipts=result.procedureReviewReceipts;runLocalRecords=validateChangeSet({changeSet:{records:result.runLocalProcedureRecords},taskType:'APPLY_PROCEDURE',snapshot:auditSnapshot,sourceScope,evidence:result.evidence,reviewReceipts:procedureReceipts}).records;auditSnapshot={...auditSnapshot,records:[...(auditSnapshot.records??[]),...runLocalRecords]};run.evidenceContext={snapshotId:snapshot.id,sourceScope:[...sourceScope],ephemeralRecords:semanticRecords,reviewReceipts:structuredClone(semanticReceipts),procedureRecords:runLocalRecords,procedureReviewReceipts:structuredClone(procedureReceipts)};result.validation={...result.validation,runLocalProcedureRecords:runLocalRecords.length,procedureFindingsNotCommitted:true};delete result.runLocalProcedureRecords;delete result.procedureReviewReceipts;}
        else if(semanticRecords.length){run.evidenceContext={snapshotId:snapshot.id,sourceScope:[...sourceScope],ephemeralRecords:semanticRecords,reviewReceipts:structuredClone(semanticReceipts)};}
        let audit=null;
        if (engine.auditEvidence) audit=await engine.auditEvidence({answerPackage:result.answerPackage,evidence:result.evidence,snapshot:auditSnapshot,sourceScope,reviewReceipts:semanticReceipts,ephemeralRecords:semanticRecords});
        result.validation={...result.validation,...validation,...(audit?{audit}:{} )};
        if (audit?.status==='invalid'&&request.type!=='AUDIT_PROJECT') throw new Error('Evidence audit rejected the answer package');
        if ((result.answerPackage.claims??[]).some(c=>c.supportState==='supported'&&!c.evidenceIds?.length)) throw new Error('A supported claim has no evidence references');

        if(result.changeSet && request.type!=='QUESTION') {
          const current=await store.getSnapshot(projectId);
          if(current.id!==snapshot.id) throw new Error('Snapshot changed before publication');
          const policy=snapshot.policy??{}; const allowed=policy.autoCommit===true || policy.commitTasks?.includes(request.type);
          if(allowed && !controller.signal.aborted && result.validation?.audit?.status!=='invalid') { run.status='publishing'; await persist(); if(controller.signal.aborted) throw new Error('Run cancelled'); run.publishedSnapshot=await store.commit(projectId,snapshot.id,result.changeSet); }
          else result.publication={status:'staged',reason:'Project policy does not allow automatic publication'};
        }
        if(controller.signal.aborted) throw new Error('Run cancelled');
        run.result=result;run.cost=result.cost??null;
        await safeWorkspaceWrite(workspaceDir,'out','answer-package.json',JSON.stringify(result.answerPackage,null,2)).catch(()=>{});
        await safeWorkspaceWrite(workspaceDir,'out','evidence.json',JSON.stringify(result.evidence,null,2)).catch(()=>{});
        await safeWorkspaceWrite(workspaceDir,'out','coverage.json',JSON.stringify(result.coverage,null,2)).catch(()=>{});
        await safeWorkspaceWrite(workspaceDir,'out','change-set.json',JSON.stringify(result.changeSet??null,null,2)).catch(()=>{});
        await safeWorkspaceWrite(workspaceDir,'out','validation.json',JSON.stringify(result.validation,null,2)).catch(()=>{});
        await safeWorkspaceWrite(workspaceDir,'state','checkpoint.json',JSON.stringify({status:'validated',snapshotId:snapshot.id,at:new Date().toISOString()})).catch(()=>{});
        for(let i=0;i<run.events.length;i++) await safeWorkspaceWrite(workspaceDir,'events',`${String(i+1).padStart(6,'0')}.json`,JSON.stringify(run.events[i])).catch(()=>{});
        run.status='completed'; run.completedAt=new Date().toISOString(); await persist();
      } catch(error) { await safeWorkspaceWrite(workspaceDir,'state','checkpoint.json',JSON.stringify({status:controller.signal.aborted?'cancelled':'failed',error:error.message,at:new Date().toISOString()})).catch(()=>{}); delete run.result; run.error=error.message; run.status=controller.signal.aborted?'cancelled':'failed'; run.completedAt=new Date().toISOString(); await persist(); }
      finally { active.delete(runId); }
    })();
    return run;
  }
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.method==='POST') {
        const origin=req.headers.origin; if(origin) { let parsed; try{parsed=new URL(origin)}catch{throw Object.assign(new Error('Invalid Origin'),{status:403})} if(parsed.host!==req.headers.host||!['http:','https:'].includes(parsed.protocol)) throw Object.assign(new Error('Cross-origin request rejected'),{status:403}); }
        if(['cross-site','cross-origin'].includes(req.headers['sec-fetch-site'])) throw Object.assign(new Error('Cross-site request rejected'),{status:403});
        if(!req.url?.endsWith('/cancel')&&!req.url?.endsWith('/publish')&&!String(req.headers['content-type']??'').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Content-Type application/json is required'),{status:415});
      }
      const url=new URL(req.url,'http://localhost'); const parts=url.pathname.split('/').filter(Boolean);
      let user=trustedLocal?{id:'trusted-local',username:'trusted-local'}:null;
      if(url.pathname==='/api/auth/bootstrap'&&req.method==='POST'){const b=await bodyJson(req,100_000);return sendJson(res,201,await auth.bootstrap(b));}
      if(url.pathname==='/api/auth/login'&&req.method==='POST'){const b=await bodyJson(req,100_000);return sendJson(res,200,await auth.login(b));}
      if(url.pathname.startsWith('/api/')&&url.pathname!=='/api/status') { if(!trustedLocal) user=await auth.authenticate(req); }
      if(url.pathname==='/api/auth/me'&&req.method==='GET')return sendJson(res,200,{user:{id:user.id,username:user.username}});
      if(url.pathname==='/api/auth/logout'&&req.method==='POST'){if(!trustedLocal)auth.revoke(/^Bearer (.+)$/.exec(req.headers.authorization??'')?.[1]);return sendJson(res,200,{ok:true});}
      if(url.pathname==='/api/auth/users'&&req.method==='POST'){const b=await bodyJson(req,100_000);return sendJson(res,201,await auth.createUser(b));}
      if(req.method==='GET'&&url.pathname==='/api/status') return sendJson(res,200,{runner:chosenRunner instanceof DeterministicRunner?'deterministic-reference':'codex-luna',execution:chosenRunner instanceof DeterministicRunner?'reference':'configured-model',configuredModel:chosenRunner instanceof DeterministicRunner?null:'gpt-6-luna',model:null});
      if(req.method==='GET'&&url.pathname==='/api/projects') { const allowed=trustedLocal?null:await auth.listProjects(user);const projects=await store.listProjects();return sendJson(res,200,{projects:allowed?projects.filter(p=>allowed.has(p.id)):projects}); }
      if(req.method==='POST'&&url.pathname==='/api/projects') { const b=await bodyJson(req); const p=await store.createProject(String(b.name??'Untitled'));if(!trustedLocal)await auth.createProject(user,p.id);await skillRegistry.initializeProject(p.id);const current=await store.getSnapshot(p.id);const snapshot=await store.commit(p.id,current.id,{procedures:STANDARD_PROCEDURES});return sendJson(res,201,{project:p,snapshot}); }
      if(parts[0]==='api'&&parts[1]==='projects'&&safeId(parts[2])) {
        const id=parts[2];
        if(!trustedLocal) {const capability=parts[3]==='fork'?'fork':parts[3]==='members'||parts[3]==='policy'||parts[3]==='procedures'||parts[3]==='skills'&&parts[4]==='approve'||parts[3]==='entities'?'manage':req.method==='GET'?'read':'write';await auth.authorizeProject(user,id,capability);}
        if(req.method==='GET'&&parts.length===3) return sendJson(res,200,{project:await store.getProject(id),snapshot:await store.getSnapshot(id)});
        if(req.method==='POST'&&parts[3]==='members'){const b=await bodyJson(req);return sendJson(res,200,await auth.grantMember(user,id,b.username,b.capabilities));}
        if(req.method==='GET'&&parts[3]==='skills'){await skillRegistry.initializeProject(id);const snap=await store.getSnapshot(id);const proc=snap.procedures.find(p=>p.id===url.searchParams.get('procedureId')&&String(p.version)===String(url.searchParams.get('procedureVersion')));return sendJson(res,200,{skills:await skillRegistry.list(id),required:[{name:CORE_SKILL,version:'1'},...(SKILLS[url.searchParams.get('type')]??[]).map(name=>({name,version:'1'})),...requiredSkillsForTask(snap,url.searchParams.get('type'),proc)]});}
        if(req.method==='POST'&&parts[3]==='skills'&&parts[4]==='request'){const b=await bodyJson(req);const snap=await store.getSnapshot(id);const proc=snap.procedures.find(p=>p.id===b.procedureId&&String(p.version)===String(b.procedureVersion));return sendJson(res,200,{requested:await skillRegistry.request(id,b.bundle,b.taskType,requiredSkillsForTask(snap,b.taskType,proc))});}
        if(req.method==='POST'&&parts[3]==='skills'&&parts[4]==='approve'){return sendJson(res,200,{approved:await skillRegistry.approve(id)});}
        if(req.method==='GET'&&parts[3]==='ancestry') return sendJson(res,200,await store.getAncestry(id));
        if(req.method==='GET'&&parts[3]==='diff') return sendJson(res,200,await store.diffProject(id));
        if(req.method==='GET'&&parts[3]==='export') return sendJson(res,200,await store.exportProject(id,url.searchParams.get('snapshotId')??undefined));
        if(req.method==='POST'&&parts[3]==='fork') { const b=await bodyJson(req);const project=await store.forkProject(id,b.snapshotId??(await store.getSnapshot(id)).id,String(b.name??'Fork'));if(!trustedLocal)await auth.forkProject(user,id,project.id);await skillRegistry.initializeProject(project.id);return sendJson(res,201,{project}); }
        if(req.method==='POST'&&parts[3]==='policy') { const b=await bodyJson(req); if(typeof b.allowUserPublish!=='boolean'||(b.commitTasks!==undefined&&(!Array.isArray(b.commitTasks)||b.commitTasks.some(t=>!TASKS.has(t))))) throw Object.assign(new Error('Policy must specify allowUserPublish and valid commitTasks'),{status:400}); const snap=await store.getSnapshot(id); const updated=await store.commit(id,snap.id,{policy:{...snap.policy,allowUserPublish:b.allowUserPublish,commitTasks:b.commitTasks??snap.policy.commitTasks??[]}}); return sendJson(res,200,{snapshot:updated}); }
        if(req.method==='POST'&&parts[3]==='procedures'&&safeId(parts[4])&&parts[5]==='approve'){const b=await bodyJson(req);if(typeof b.version!=='string'||typeof b.expectedSnapshotId!=='string')throw Object.assign(new Error('Exact version and expected snapshot are required'),{status:400});const snapshot=await store.approveProcedure(id,b.expectedSnapshotId,{id:parts[4],version:b.version,reviewedBy:user.username});const procedure=snapshot.procedures.find(p=>p.id===parts[4]&&String(p.version)===b.version);return sendJson(res,200,{procedure,snapshot});}
        if(req.method==='POST'&&parts[3]==='rebase') { const b=await bodyJson(req); if(!trustedLocal){const child=await store.getProject(id);if(!child.parentProjectId)throw Object.assign(new Error('Root projects cannot be rebased'),{status:409});await auth.authorizeProject(user,child.parentProjectId,'fork');const parentSnapshot=await store.getSnapshot(child.parentProjectId,b.newParentSnapshotId);if(!parentSnapshot)throw Object.assign(new Error('Parent snapshot not found'),{status:404});} return sendJson(res,200,{snapshot:await store.rebaseProject(id,b.newParentSnapshotId)}); }
        if(req.method==='POST'&&parts[3]==='entities'&&parts[4]==='reconcile'){const b=await bodyJson(req);const result=await store.reconcileEntities(id,b.expectedSnapshotId,{fromEntityId:b.fromEntityId,toEntityId:b.toEntityId,reviewedBy:user.username});return sendJson(res,200,result);}
        if(req.method==='POST'&&parts[3]==='entities'&&parts[4]==='undo'){const b=await bodyJson(req);const result=await store.undoEntityReconciliation(id,b.expectedSnapshotId,b.operationId,{reviewedBy:user.username});return sendJson(res,200,result);}
        if(req.method==='GET'&&parts[3]==='sources'&&safeId(parts[4])) {const snap=await store.getSnapshot(id,url.searchParams.get('snapshotId')??undefined);const source=snap?.sources.find(s=>s.id===parts[4]||s.sourceVersionId===parts[4]);if(!source)return sendJson(res,404,{error:'Source not found'});const regionId=parts[5]==='regions'?parts[6]:null;if(regionId){const region=source.regions?.find(r=>r.id===regionId);return sendJson(res,region?200:404,region?{source:{id:source.id,sourceVersionId:source.sourceVersionId,sourceId:source.sourceId,name:source.name,mimeType:source.mimeType},region}: {error:'Source region not found'});}if(parts[5]==='original'){const bytes=await store.readSource(source.sourceVersionId??source.id);return sendJson(res,200,{source:{id:source.id,sourceVersionId:source.sourceVersionId,sourceId:source.sourceId,name:source.name,mimeType:source.mimeType,digest:source.digest},contentBase64:bytes.toString('base64')});}return sendJson(res,200,{source});}
        if(req.method==='POST'&&parts[3]==='sources') { const b=await bodyJson(req); if(typeof b.content!=='string'||b.content.length>40_000_000) throw Object.assign(new Error('content must be a base64 string under 30 MB'),{status:400}); const current=await store.getSnapshot(id);if(b.expectedSnapshotId&&b.expectedSnapshotId!==current.id)throw Object.assign(new Error('Snapshot conflict; refresh before uploading'),{status:409});if(b.sourceId&&!current.sources.some(s=>(s.sourceId??s.id)===b.sourceId))throw Object.assign(new Error('Replacement source does not belong to this project'),{status:404});const {source,snapshot}=await store.registerSource(id,{name:b.name,content:Buffer.from(b.content,'base64'),mimeType:b.mimeType,sourceId:b.sourceId,expectedSnapshotId:b.expectedSnapshotId??current.id}); return sendJson(res,201,{source,snapshot}); }
        if(req.method==='POST'&&parts[3]==='requests') { const b=await bodyJson(req); if(!TASKS.has(b.type)||typeof b.text!=='string') throw Object.assign(new Error('Invalid request type or text'),{status:400}); const run=await launch(id,b); return sendJson(res,202,{runId:run.id,status:run.status,execution:run.execution}); }
        if(req.method==='GET'&&parts[3]==='runs') return sendJson(res,200,{runs:await store.listRuns(id)});
        if(req.method==='GET'&&parts[3]==='snapshot') { const snap=await store.getSnapshot(id,url.searchParams.get('id')??undefined); return sendJson(res,snap?200:404,{snapshot:snap}); }
      }
      if(parts[0]==='api'&&parts[1]==='runs'&&safeId(parts[2])) {
        const runId=parts[2];
        if(!trustedLocal){const known=await store.getRun(runId).catch(()=>null);if(!known)return sendJson(res,404,{error:'Run not found'});const capability=parts[3]==='publish'?'publish':req.method==='GET'?'read':'write';await auth.authorizeProject(user,known.projectId,capability);}
        if(req.method==='GET'&&parts.length===3) return sendJson(res,200,{run:await store.getRun(runId)});
        if(req.method==='POST'&&parts[3]==='resume'){const run=await store.getRun(runId);if(run.status!=='interrupted'||!run.request)return sendJson(res,409,{error:'Run is not resumable'});const head=await store.getSnapshot(run.projectId);if(head.id!==run.snapshotId)return sendJson(res,409,{error:'Pinned snapshot is no longer current; fork or submit a new request'});const resumed=await launch(run.projectId,run.request,run);return sendJson(res,202,{runId:resumed.id,status:resumed.status,execution:resumed.execution,sessionId:resumed.sessionId??null});}
        if(req.method==='POST'&&parts[3]==='skills'&&parts[4]==='link'){const run=await store.getRun(runId);if(!['interrupted','failed'].includes(run.status))return sendJson(res,409,{error:'Skills can only be linked to an interrupted or failed run before resuming'});const snap=await store.getSnapshot(run.projectId,run.snapshotId),proc=snap.procedures.find(p=>p.id===run.request?.procedureId&&String(p.version)===String(run.request?.procedureVersion));const selected=await skillRegistry.assertApproved(run.projectId,run.type,(await bodyJson(req)).bundle,requiredProcedureSkills(proc));run.request.skillBundle=selected;run.skillBundle=selected;run.status='interrupted';run.error=null;await store.saveRun(run);return sendJson(res,200,{runId,skillBundle:selected,sessionId:run.sessionId??null});}
        if(req.method==='POST'&&parts[3]==='cancel') { const x=active.get(runId); if(!x||x.run.status==='publishing') return sendJson(res,409,{error:x?'Run has entered the non-cancellable publication phase':'Run is no longer active'}); x.controller.abort(new Error('Cancelled by user')); return sendJson(res,202,{runId,status:'cancelling'}); }
        if(req.method==='POST'&&parts[3]==='publish') { const run=await store.getRun(runId); if(!run||run.status!=='completed'||!run.result?.changeSet) return sendJson(res,409,{error:'No completed staged change set is available'}); const snap=await store.getSnapshot(run.projectId); if(snap.id!==run.snapshotId) return sendJson(res,409,{error:'Project snapshot changed; rerun before publishing'}); if(snap.policy?.allowUserPublish!==true&&!snap.policy?.commitTasks?.includes(run.type)) return sendJson(res,403,{error:'Project policy does not allow user publication'}); const {validateChangeSet}=await import('./runtime/change-validation.mjs'); const changeSet=validateChangeSet({changeSet:run.result.changeSet,taskType:run.type,snapshot:snap,sourceScope:run.sourceScope,evidence:run.result.evidence,reviewReceipts:run.reviewReceipts??[]}); const publishedSnapshot=await store.commit(run.projectId,run.snapshotId,changeSet); run.publishedSnapshot=publishedSnapshot; await store.saveRun(run); return sendJson(res,200,{snapshot:publishedSnapshot}); }
        if(req.method==='GET'&&parts[3]==='explain') { const r=await store.getRun(runId); return sendJson(res,r?.result?200:404,{answerPackage:r?.result?.answerPackage,evidence:r?.result?.evidence,evidenceContext:r?.evidenceContext??null,validation:r?.result?.validation}); }
      }
      if(req.method==='GET' && (url.pathname==='/' || url.pathname.startsWith('/app.') || url.pathname.startsWith('/style.'))) { const filename=url.pathname==='/'?'index.html':url.pathname.slice(1); const path=resolve(ROOT,'public',filename); if(!path.startsWith(resolve(ROOT,'public')+'/')) return sendJson(res,404,{error:'Not found'}); const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}; const content=await readFile(path); res.writeHead(200,{'content-type':types[extname(path)]??'application/octet-stream'}); return res.end(content); }
      sendJson(res,404,{error:'Not found'});
    } catch(error) { sendJson(res,error.status??400,{error:error.message}); }
  });
  return {server,store,runner:chosenRunner,auth,recoverRuns,listen:async(port=3000,host='127.0.0.1')=>{await Promise.all([auth.initialize(),store.ready]);await recoverRuns();return new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolveListen(server.address()));});}};
}

if(import.meta.url===`file://${process.argv[1]}`){ const app=createApp({dataDir:process.env.SKR_DATA_DIR??resolve(process.cwd(),'data'),runnerMode:process.env.SKR_RUNNER==='reference'?'reference':'codex-luna',trustedLocal:process.env.SKR_TRUSTED_LOCAL==='1'}); const addr=await app.listen(Number(process.env.PORT??3000)); console.log(`SKR listening on http://${addr.address}:${addr.port} (runner: ${process.env.SKR_RUNNER==='reference'?'deterministic reference':'Codex GPT-6-Luna'}, auth: ${process.env.SKR_TRUSTED_LOCAL==='1'?'trusted-local':'required'})`); }
