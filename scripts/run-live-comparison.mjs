import { readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { ProjectStore } from '../src/store.mjs';
import { runResearchComparison } from '../src/evaluation/baselines.mjs';
import { loadPriceSchedule } from '../src/evaluation/pricing.mjs';

const arg=name=>{const item=process.argv.find(x=>x.startsWith(`--${name}=`));return item?.slice(name.length+3);};
const sha=value=>createHash('sha256').update(value).digest('hex');
const snapshotJson=arg('snapshot-json');
const snapshotId=arg('snapshot');
let snapshot;
if(snapshotJson){const parsed=JSON.parse(await readFile(resolve(snapshotJson),'utf8'));snapshot=parsed.snapshot??parsed;}
else {
  const snapshotRoot=resolve(arg('snapshot-root')??'');if(!snapshotRoot||!snapshotId)throw new Error('Use --snapshot-json=<sanitized-export.json> or both --snapshot-root=<ProjectStore-dir> and --snapshot=<id>');
  const store=new ProjectStore({rootDir:snapshotRoot}),disk=JSON.parse(await readFile(join(snapshotRoot,'snapshots',`${snapshotId}.json`),'utf8'));snapshot=await store.getSnapshot(disk.projectId,snapshotId);
}
if(!snapshot?.id||!Array.isArray(snapshot.sources))throw new Error('Snapshot export needs a stable id and pinned source records');
const snapshotSha=sha(JSON.stringify(snapshot));
const questionSetPath=arg('questions');
let questionSet=null,items=[];
if(questionSetPath){questionSet=JSON.parse(await readFile(resolve(questionSetPath),'utf8'));items=questionSet.questions??questionSet.cases??[];if(!items.length)throw new Error('Question fixture has no cases/questions');}
else items=[{id:'single-question',question:arg('question')??'How many little rabbits were there, and what were their names?',sourceVersionId:arg('source-version')??snapshot.sources[0].sourceVersionId??snapshot.sources[0].id}];
const fixtureBytes=questionSetPath?await readFile(resolve(questionSetPath)):Buffer.from(JSON.stringify(items));
const fixtureSha=sha(fixtureBytes),limit=Number(arg('limit')??1),startAt=Number(arg('start')??0);
if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(startAt)||startAt<0)throw new RangeError('--limit must be a positive integer and --start a nonnegative integer');
let freezeManifest=null;if(questionSetPath){try{freezeManifest=JSON.parse(await readFile(`${resolve(questionSetPath)}.lock.json`,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
if(questionSetPath&&!freezeManifest&&!process.argv.includes('--allow-unfrozen'))throw new Error('Question fixture requires a matching .lock.json freeze manifest; pass --allow-unfrozen explicitly for a smoke run.');
if(freezeManifest&&freezeManifest.sha256!==fixtureSha)throw new Error(`Question fixture freeze mismatch: expected ${freezeManifest.sha256}, received ${fixtureSha}`);
const selectedItems=items.slice(startAt,startAt+limit);
const mode=arg('mode')??'quality-first',equal=mode==='equal-budget';
if(!['quality-first','equal-budget'].includes(mode))throw new TypeError(`Unknown comparison mode ${mode}`);
if(!selectedItems.length)throw new RangeError(`No cases selected at offset ${startAt}`);
const outputPath=resolve(arg('output')??'artifacts/research/latest-live-comparison.json');
const checkpointDir=resolve(arg('checkpoint-dir')??join('artifacts','research','live-checkpoints',fixtureSha.slice(0,16)));await mkdir(checkpointDir,{recursive:true});
const baselineList=(arg('baselines')??'hybrid-rag,agentic-rag,graphrag,full-source-agent,skr-direct,skr-full').split(',').filter(Boolean);
if(!baselineList.length||baselineList.some(x=>!['hybrid-rag','agentic-rag','graphrag','full-source-agent','skr-direct','skr-full'].includes(x)))throw new TypeError('Select one or more known baseline IDs');
const amortizationQueries=Number(arg('amortization-queries')??1);if(!Number.isSafeInteger(amortizationQueries)||amortizationQueries<1)throw new RangeError('--amortization-queries must be a positive integer');
const priceSchedulePath=arg('price-schedule'),priceSchedule=await loadPriceSchedule(priceSchedulePath,{model:'gpt-6-luna'}),priceScheduleSha=priceSchedulePath?sha(await readFile(resolve(priceSchedulePath))):null;
const preprocessingReportPath=arg('preprocessing-report'),preprocessingMetadata=preprocessingReportPath?JSON.parse(await readFile(resolve(preprocessingReportPath),'utf8')):null,preprocessingReportSha=preprocessingReportPath?sha(await readFile(resolve(preprocessingReportPath))):null;
const rows=[];
for(const item of selectedItems){
  const id=String(item.id??`case-${startAt+rows.length+1}`),text=String(item.question??item.text??'');if(!text)throw new Error(`Question ${id} has no question text`);
  const scopeValue=item.sourceVersionId??item.source?.sourceVersionId??item.source?.sourceId??item.source?.bookId??item.sourceId;
  const source0=snapshot.sources.find(s=>(s.sourceVersionId??s.id)===scopeValue||s.sourceId===scopeValue||s.id===scopeValue)
    ??snapshot.sources.find(s=>[item.sourceId,item.source?.bookId,item.source?.sourceId].some(x=>x&&[s.sourceId,s.id,s.sourceId].includes(x)));
  let source=source0;
  if(!source)throw new Error(`Question ${id} source ${scopeValue??'(unspecified)'} is not in the pinned snapshot`);
  const sourceVersionId=source.sourceVersionId??source.id;
  const expectedDigest=item.source?.sha256??item.sourceDigest??null;if(expectedDigest&&source.digest!==expectedDigest)throw new Error(`Question ${id} source checksum does not match the pinned snapshot`);
  const sourceScope=[sourceVersionId];
  // Select whole-work regions from pinned source locators and exact Gutenberg markers.
  const fullText=source.regions.map(r=>r.text).join('\n'),startMarker='*** START OF THE PROJECT GUTENBERG EBOOK',endMarker='*** END OF THE PROJECT GUTENBERG EBOOK',marker=fullText.indexOf(startMarker),bodyStart=fullText.indexOf('\n',marker)+1,bodyEnd=fullText.indexOf(endMarker,bodyStart);
  if(marker>=0&&bodyStart>0&&bodyEnd>=bodyStart){let offset=0;const starts=new Map();for(const r of source.regions){starts.set(r.id,{start:offset,end:offset+r.text.length});offset+=r.text.length+1;}
    const included=source.regions.filter(r=>{const p=starts.get(r.id);return p.start>=bodyStart&&p.end<=bodyEnd;});if(!included.length)throw new Error(`No complete-work regions found for ${source.name}`);
    const indices=new Set(included.map(r=>r.id));source={...source,regions:included,completeWork:{boundaryMarkers:'Project Gutenberg START/END',coordinateBasis:'joined-region-stream-with-single-newlines',start:bodyStart,end:bodyEnd,excludedHeaderRegions:source.regions.filter(r=>!indices.has(r.id)&&starts.get(r.id).end<=bodyStart).map(r=>r.id),excludedFooterRegions:source.regions.filter(r=>!indices.has(r.id)&&starts.get(r.id).start>=bodyEnd).map(r=>r.id)}};
  }
  const runSnapshot={...snapshot,sources:snapshot.sources.map(s=>(s.sourceVersionId??s.id)===sourceVersionId?source:s)};
  const budget={totalPromptChars:equal?35000:Number.MAX_SAFE_INTEGER,totalInputTokens:equal?60000:Number.MAX_SAFE_INTEGER,maxToolCalls:equal?48:Number.MAX_SAFE_INTEGER,graphExtractionChars:40000,graphExtractionTurns:24};
  const decision=item.adjudication?.decision??null,adjudicationStatus=item.adjudication?.status??item.gold?.adjudication?.status??'pending-human-review';
  const adjudicatedAnswer=decision==='revise'?item.adjudicatedAnswer??item.adjudication?.correctedAnswer:decision==='accept'?item.expected??item.gold?.answer:item.adjudicatedAnswer??null;
  const goldCandidate=decision==='reject'||adjudicationStatus==='rejected'?null:adjudicatedAnswer?{...(item.gold??{}),answer:adjudicatedAnswer,evidence:item.adjudicatedEvidence??item.evidence??item.gold?.evidence??[],adjudication:item.adjudication??{status:'pending-human-review'}}:item.gold??{answer:item.expected??null,evidence:item.evidence??[],adjudication:item.adjudication??'pending-human-review'};
  const hasReference=typeof goldCandidate?.answer==='string'&&goldCandidate.answer.trim().length>0;
  const runJudge=process.argv.includes('--judge')&&hasReference;
  if(preprocessingMetadata?.source?.sha256&&preprocessingMetadata.source.sha256!==source.digest)throw new Error('Preprocessing report source digest differs from the selected snapshot source');
  const profile={runnerVersion:'paired-live-runner-v4',fixtureSha,snapshotId:snapshot.id,snapshotSha,caseId:id,question:text,sourceScope,procedureId:item.procedureId??item.procedure?.id??null,procedureVersion:item.procedureVersion??item.procedure?.version??null,parameters:item.parameters??{},mode,judge:runJudge,judgeVersion:'independent-answer-evidence-judge-v1',goldSha:runJudge?sha(JSON.stringify(goldCandidate)):null,baselines:baselineList,amortizationQueries,priceScheduleSha,preprocessingReportSha,budget};
  const checkpointPath=join(checkpointDir,`${id.replace(/[^A-Za-z0-9_-]/g,'_')}.json`),profileSha=sha(JSON.stringify(profile));
  try{const saved=JSON.parse(await readFile(checkpointPath,'utf8'));if(saved.profileSha===profileSha){rows.push(saved.row);process.stdout.write(`${id}: reused paired checkpoint\n`);continue;}}catch{}
  const workspaceRoot=join(tmpdir(),`skr-live-paired-${randomUUID()}`);await mkdir(workspaceRoot,{recursive:true});
  try{
    const judge=runJudge,gold=judge?goldCandidate:undefined;
  const report=await runResearchComparison({question:{text,procedureId:item.procedureId??item.procedure?.id,procedureVersion:item.procedureVersion??item.procedure?.version,parameters:item.parameters??item.procedure?.parameters},snapshot:runSnapshot,sources:[source],sourceScope,workspaceRoot,mode,amortizationQueries,baselines:baselineList,budget,priceSchedule,preprocessingMetadata,...(gold?{gold,adjudicationStatus:adjudicationStatus==='human-adjudicated'?'human-adjudicated':'automatic-reference-pending-human-review'}:{})});
    const row={caseId:id,question:text,source:{sourceVersionId,name:source.name,digest:source.digest,completeWork:source.completeWork??null},report};rows.push(row);
    const tmp=`${checkpointPath}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify({fixtureSha,profileSha,row},null,2)+'\n',{mode:0o600});await rename(tmp,checkpointPath);
    process.stdout.write(`${id}: paired ${report.rows.length} baselines\n`);
  }finally{await rm(workspaceRoot,{recursive:true,force:true});}
}
const baselineIds=baselineList,mean=(xs)=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
let randomSeed=parseInt(fixtureSha.slice(0,8),16)>>>0;const rand=()=>{randomSeed^=randomSeed<<13;randomSeed^=randomSeed>>>17;randomSeed^=randomSeed<<5;return (randomSeed>>>0)/4294967296;},replicates=5000,quantile=(xs,p)=>xs.length?xs[Math.min(xs.length-1,Math.floor(xs.length*p))]:null;
const bootstrapMean=values=>{if(values.length<2)return null;const samples=[];for(let b=0;b<replicates;b++){let total=0;for(let i=0;i<values.length;i++)total+=values[Math.floor(rand()*values.length)];samples.push(total/values.length);}samples.sort((a,b)=>a-b);return [quantile(samples,0.025),quantile(samples,0.975)];};
const perBaseline=baselineIds.map(baseline=>{const values=rows.map(x=>x.report?.rows?.find(r=>r.baseline===baseline)).filter(Boolean),answers=values.map(x=>x.adjudication?.answerCorrect).filter(Number.isFinite),precisions=values.map(x=>x.adjudication?.evidencePrecision).filter(Number.isFinite),recalls=values.map(x=>x.adjudication?.evidenceRecall).filter(Number.isFinite);return {baseline,cases:values.length,errors:rows.filter(x=>x.report?.rows?.some(r=>r.baseline===baseline&&r.error)).length,answerCorrectMean:mean(answers),answerCorrectBootstrap95:bootstrapMean(answers),answerJudgedN:answers.length,evidencePrecisionMean:mean(precisions),evidencePrecisionBootstrap95:bootstrapMean(precisions),evidencePrecisionN:precisions.length,evidenceRecallMean:mean(recalls),evidenceRecallBootstrap95:bootstrapMean(recalls),evidenceRecallN:recalls.length,validAudits:values.filter(x=>x.result?.validation?.status==='valid').length,unresolved:values.filter(x=>x.result?.answerPackage?.supportState==='unresolved').length,contested:values.filter(x=>x.result?.answerPackage?.supportState==='contested').length,budgetIneligible:values.filter(x=>x.result?.cost?.budget?.status==='ineligible').length};});
const paired=[];for(const row of rows){const entries=row.report?.rows??[],full=entries.find(x=>x.baseline==='skr-full')?.adjudication?.answerCorrect,direct=entries.find(x=>x.baseline==='skr-direct')?.adjudication?.answerCorrect;if(Number.isFinite(full)&&Number.isFinite(direct))paired.push(full-direct);}const pairedBoot=bootstrapMean(paired);
const result={experiment:'paired-live-baseline-evaluation',status:'measured-model-runs-pending-human-adjudication',model:'gpt-6-luna',mode,fixture:{path:questionSetPath??null,sha256:fixtureSha,freezeManifest:freezeManifest?{verified:true,freezeVersion:freezeManifest.freezeVersion}:null,caseCount:items.length,selectedCount:rows.length,offset:startAt,caseFreezeStatus:questionSet?.status??'single-question'},snapshotId:snapshot.id,snapshotSha,priceSchedule:priceSchedule?{...priceSchedule,path:priceSchedulePath,sha256:priceScheduleSha}:null,baselineList,summary:{perBaseline,pairedFullVsDirect:{metric:'model-judged answer correctness',n:paired.length,meanDifference:mean(paired),bootstrap95:pairedBoot},bootstrap:{method:'paired case-resampling with replacement; deterministic seed from fixture digest',resamples:paired.length>=2?replicates:0,n:paired.length,confidenceIntervalAvailable:paired.length>=2,seed:fixtureSha.slice(0,8)}},rows,limitations:['Automatic question/answer annotations remain pending human review.','A small smoke is not evidence of general baseline ranking.','Bootstrap intervals are suppressed below two paired observations.']};
await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify({output:outputPath,mode,fixtureSha,caseCount:rows.length,baselines:baselineList,checkpointDir},null,2)+'\n');
