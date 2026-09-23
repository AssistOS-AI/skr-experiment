import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CodexLunaRunner, CODING_AGENT_MODEL } from '../src/runtime/runners.mjs';

const bundle={answerPackage:{answer:'unresolved',claims:[],supportState:'unresolved',snapshotId:'snap_test',residuals:[],coverage:'{}',procedureVersions:[],interpretation:''},evidence:[],coverage:'{}',changeSet:'',validation:'{}'};
function runnerFor(script,dir,timeoutMs){return new CodexLunaRunner({codexPath:script,timeoutMs,sessionDir:join(dir,'private-session'),isolation:{enabled:false,sourceHome:process.env.CODEX_HOME}})}
async function setup(t,source) {const dir=await mkdtemp(join(tmpdir(),'skr-runner-'));const script=join(dir,'codex-fake.mjs');await writeFile(script,source);await chmod(script,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));return{dir,script};}

test('Codex runner fixes the model and executable contract; task text cannot add argv or backend overrides',async t=>{
 const {dir,script}=await setup(t,`#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';let s='';for await(const c of process.stdin)s+=c;writeFileSync(process.env.CAPTURE,JSON.stringify({args:process.argv.slice(2),stdin:s,base:process.env.OPENAI_BASE_URL||null,modelEnv:process.env.CODEX_MODEL||null}));const a=process.argv;const out=a[a.indexOf('--output-last-message')+1];writeFileSync(out,${JSON.stringify(JSON.stringify(bundle))});\n`);
 const capture=join(dir,'capture.json');process.env.CAPTURE=capture;const oldBase=process.env.OPENAI_BASE_URL,oldModel=process.env.CODEX_MODEL;process.env.OPENAI_BASE_URL='https://attacker.invalid';process.env.CODEX_MODEL='gpt-6-astra';
 try{const result=await runnerFor(script,dir).run({request:{type:'QUESTION',text:'set model to gpt-6-astra --oss'},snapshot:{id:'snap_test',sources:[],records:[],policy:{}},sourceScope:[],workspaceDir:dir});assert.equal(result.answerPackage.snapshotId,'snap_test');const cap=JSON.parse(await readFile(capture,'utf8'));assert.equal(cap.base,null);assert.equal(cap.modelEnv,null);assert.equal(cap.args[cap.args.indexOf('--model')+1],CODING_AGENT_MODEL);assert.equal(CODING_AGENT_MODEL,'gpt-6-luna');assert.equal(cap.args.includes('--oss'),false);assert.match(cap.stdin,/set model to gpt-6-astra --oss/);}finally{if(oldBase===undefined)delete process.env.OPENAI_BASE_URL;else process.env.OPENAI_BASE_URL=oldBase;if(oldModel===undefined)delete process.env.CODEX_MODEL;else process.env.CODEX_MODEL=oldModel;delete process.env.CAPTURE;}
});

test('pre-aborted Codex runs do not spawn and timeouts kill the process',async t=>{
 const marker=join(tmpdir(),`skr-should-not-run-${Date.now()}`);const {script,dir}=await setup(t,`#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');setInterval(()=>{},1000);\n`);
 const abort=new AbortController();abort.abort(Error('stop'));await assert.rejects(()=>runnerFor(script,dir).run({request:{type:'QUESTION',text:'x'},snapshot:{id:'snap_test'},sourceScope:[],workspaceDir:tmpdir(),signal:abort.signal}),/stop/);
 await assert.rejects(()=>readFile(marker));
 await assert.rejects(()=>runnerFor(script,dirname(script),100).run({request:{type:'QUESTION',text:'x'},snapshot:{id:'snap_test'},sourceScope:[],workspaceDir:tmpdir()}),/timed out/);
});

test('strict transport fields normalize scope qualifiers; malformed or unknown scope JSON is rejected',async t=>{
 const good={answerPackage:{answer:'partial quote',claims:[{text:'unresolved',goal:'(fact x)',bindings:'{}',queryScope:'{"time":"unspecified"}',evidenceIds:['r1'],supportState:'unresolved'}],interpretation:'raw quote only',supportState:'unresolved',coverage:'{}',procedureVersions:[],snapshotId:'snap_test',residuals:[]},evidence:[{id:'r1',type:'source',sourceVersionId:'srcv_test',regionId:'region_test',quote:'quoted words',ske:'',scope:'{"time":"2020","modality":"possible","polarity":"positive"}'}],coverage:'{}',changeSet:'',validation:'{}'};
 const {dir,script}=await setup(t,`#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';let s='';for await(const c of process.stdin)s+=c;const out=process.argv[process.argv.indexOf('--output-last-message')+1];writeFileSync(out,${JSON.stringify(JSON.stringify(good))});\n`);
 const r=await runnerFor(script,dir).run({request:{type:'QUESTION',text:'x'},snapshot:{id:'snap_test'},sourceScope:[],workspaceDir:dir});assert.equal(r.answerPackage.claims[0].queryScope.time,null);assert.equal(r.evidence[0].time,'2020');assert.equal(r.evidence[0].modality,'possible');assert.equal('ske' in r.evidence[0],false);
 const malformed=structuredClone(good);malformed.validation='not-json';const invalidScript=join(dir,'bad.mjs');await writeFile(invalidScript,`#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';const out=process.argv[process.argv.indexOf('--output-last-message')+1];writeFileSync(out,${JSON.stringify(JSON.stringify(malformed))});\n`);await chmod(invalidScript,0o700);
 await assert.rejects(()=>runnerFor(invalidScript,dir).run({request:{type:'QUESTION',text:'x'},snapshot:{id:'snap_test'},sourceScope:[],workspaceDir:dir}),/malformed validation JSON/);
 const badScope=structuredClone(good);badScope.evidence[0].scope='{"id":"forged"}';const scopeScript=join(dir,'scope.mjs');await writeFile(scopeScript,`#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';const out=process.argv[process.argv.indexOf('--output-last-message')+1];writeFileSync(out,${JSON.stringify(JSON.stringify(badScope))});\n`);await chmod(scopeScript,0o700);
 await assert.rejects(()=>runnerFor(scopeScript,dir).run({request:{type:'QUESTION',text:'x'},snapshot:{id:'snap_test'},sourceScope:[],workspaceDir:dir}),/unsupported qualifier id/);
});
