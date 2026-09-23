import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { makeSourceChunks, bm25Search, runBaselineRequest, BASELINE_IDS, procedureCoverageComplete, procedureContextEvidence, normalizeEvidenceSpan, mapGoldEvidenceSpans, unionEvidenceIntervals, evidenceIntersectionLength } from '../src/evaluation/baselines.mjs';
import { auditEvidence } from '../src/engine/index.mjs';

const source={id:'book-v1',sourceId:'book',sourceVersionId:'book-v1',regions:[{id:'chapter-2',text:'\n\nAlice carried the silver key into the garden.\n\nThe gardener hid the key beneath the oak tree.'}]};

test('chunks preserve original region identity, exact quote, and source offsets',()=>{
  const [chunk]=makeSourceChunks([source],{maxChars:1000});
  assert.equal(chunk.regionId,'chapter-2');assert.equal(chunk.parentRegionId,'chapter-2');
  assert.equal(source.regions[0].text.slice(chunk.startChar,chunk.endChar),chunk.text);
  assert.equal(chunk.locator.startChar,chunk.startChar);
});

test('lexical retrieval only returns matching source passages',()=>{
  const chunks=makeSourceChunks([source]);const found=bm25Search('silver key garden',chunks);
  assert.ok(found.length>=1);assert.match(found[0].text,/silver key/);
});

test('baseline set has six real request paths',()=>assert.deepEqual(BASELINE_IDS,['hybrid-rag','agentic-rag','graphrag','full-source-agent','skr-direct','skr-full']));

test('SKR direct disables explicit rule execution while SKR full derives the answer',async()=>{
  const pinnedSource={...source,regions:[{id:'chapter-2',text:'(parent alice bob)\n(parent bob chris)'}]};
  const snapshot={id:'s',records:[
    {id:'a',ske:'(parent alice bob)',sourceVersionId:'book-v1',regionId:'chapter-2',quote:'(parent alice bob)',supportState:'supported',lifecycle:'current'},
    {id:'b',ske:'(parent bob chris)',sourceVersionId:'book-v1',regionId:'chapter-2',quote:'(parent bob chris)',supportState:'supported',lifecycle:'current'}],sources:[pinnedSource],
    rules:[{id:'r',version:'1',status:'current',premises:['(parent ?x ?y)','(parent ?y ?z)'],conclusion:'(grandparent ?x ?z)'}],procedures:[]};
  const question={text:'Who is the grandparent of Chris?',goal:'(find (?x) (grandparent ?x chris))'};
  const direct=await runBaselineRequest({baseline:'skr-direct',question,snapshot,sources:[pinnedSource],sourceScope:['book-v1']});
  const full=await runBaselineRequest({baseline:'skr-full',question,snapshot,sources:[pinnedSource],sourceScope:['book-v1']});
  assert.equal(direct.answerPackage.supportState,'unresolved');assert.equal(full.answerPackage.supportState,'supported');
  assert.equal(full.answerPackage.claims[0].bindings.x.value,'alice');
  assert.equal(full.validation.auditStatus,'valid');
});

test('SKR Full integrates the goal-directed semantic loop and preserves audited structured claims',async()=>{
  const pinned={...source,regions:[{id:'chapter-2',text:'(located_in service europe)'}]};
  const fact={id:'fact1',ske:'(located_in service europe)',sourceVersionId:'book-v1',regionId:'chapter-2',quote:'(located_in service europe)',supportState:'supported',lifecycle:'current',validation:'source-checked'};
  const snapshot={id:'s',records:[fact],sources:[pinned],rules:[],procedures:[]};
  let calls=0;
  const session={request:async({prompt})=>{calls++;assert.match(prompt,/Answer the question/);return {output:{answer:'The service is in Europe.',claims:[],citationIds:['fact1'],supportState:'supported',residuals:[]},usage:{input_tokens:20,output_tokens:5},wallMs:1,sessionId:'test-luna'};}};
  const dir=await mkdtemp(join(tmpdir(),'skr-semantic-baseline-'));try{const out=await runBaselineRequest({baseline:'skr-full',question:{text:'Where is service?',goal:'(located_in service europe)'},snapshot,sources:[pinned],sourceScope:['book-v1'],session,workspaceDir:dir});
    assert.equal(calls,1);assert.equal(out.answerPackage.supportState,'supported');assert.ok(out.answerPackage.claims.some(c=>c.supportState==='supported'&&c.goal));assert.equal(out.validation.auditStatus,'valid');assert.equal(out.trace.semanticResolutionStatus,'complete');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('explicit QUESTION procedure selection returns run-local reviewed findings and receipts without mutating the snapshot',async()=>{
  const pinned={id:'src-method',sourceId:'book-method',sourceVersionId:'src-method',regions:[{id:'region-method',text:'Mira walks to Paris.'}]};
  const procedure={id:'literary',version:'1.0.0',active:true,purpose:'Assess a passage.',ordered_steps:['Read passage'],evidence_obligations:['Cite passage']};
  const snapshot={id:'snap-method',sources:[pinned],records:[],rules:[],procedures:[procedure],coverage:[],policy:{}};
  const passageId=`passage_${createHash('sha256').update('src-method:region-method').digest('hex').slice(0,24)}`;let calls=0;
  const session={async request({schema}){calls++;const required=schema.required;let output;if(required.includes('chunkId'))output={chunkId:schema.properties.chunkId.enum[0],findings:[{summary:'A character travels to a named city.',evidenceIds:[passageId],counterevidenceIds:[],supportState:'unresolved',score:null,criterion:'characterization'}],coverage:{reviewStatus:'complete',unreviewedRegionIds:[]}};else if(required.includes('proposals'))output={proposals:[],subgoals:[],uncertainties:[]};else if(required.includes('answer'))output={answer:'The passage receives a provisional review.',claims:[],citationIds:[],supportState:'unresolved',residuals:[]};else throw new Error(`Unexpected method-question schema: ${required.join(',')}`);return{output,sessionId:'method-question-session',usage:{input_tokens:2,output_tokens:1},wallMs:1}}};
  const dir=await mkdtemp(join(tmpdir(),'skr-question-method-'));try{const out=await runBaselineRequest({baseline:'skr-full',question:{text:'Assess Mira\'s journey.',goal:'(located_in entity:mira place:paris)',procedureId:'literary',procedureVersion:'1.0.0',parameters:{}},snapshot,sources:[pinned],sourceScope:['src-method'],session,workspaceDir:dir});assert.ok(out.runLocalProcedureRecords.length>0);assert.equal(out.procedureReviewReceipts.length,out.runLocalProcedureRecords.length);assert.equal(out.runLocalProcedureRecords[0].procedureId,'literary');assert.equal(out.runLocalProcedureRecords[0].procedureVersion,'1.0.0');assert.equal(snapshot.records.length,0);assert.equal(out.validation.auditStatus,'valid');assert.ok(calls>=2);}finally{await rm(dir,{recursive:true,force:true});}
});

test('agentic and GraphRAG execute retrieval loops with disclosed mechanisms',async()=>{
  const docs=Array.from({length:8},(_,i)=>({id:`d${i}`,sourceId:'book',sourceVersionId:'book-v1',regionId:`r${i}`,text:i<4?`Alice speaks with the gardener in chapter ${i}.`:`The silver key rests beneath the oak tree in chapter ${i}.`}));
  const sources=[{...source,regions:docs.map(d=>({id:d.regionId,text:d.text}))}];
  const snapshot={id:'empty',records:[],rules:[],procedures:[]};
  const agentic=await runBaselineRequest({baseline:'agentic-rag',question:{text:'Where is the silver key?'},snapshot,sources,sourceScope:['book-v1']});
  const graphIndexDir=await mkdtemp(join(tmpdir(),'skr-graph-index-test-'));
  const graph=await runBaselineRequest({baseline:'graphrag',question:{text:'Where is the silver key?'},snapshot,sources,sourceScope:['book-v1'],budget:{graphIndexDir}});
  assert.ok(agentic.trace.iterations.length>=1);assert.equal(agentic.trace.adapterStatus,'offline-deterministic-search-loop');
  assert.equal(graph.trace.graph.communityMethod,'deterministic weighted Louvain local-modularity optimization');
  assert.equal(graph.trace.graphIndexCacheHit,false);await rm(graphIndexDir,{recursive:true,force:true});
});

test('live agentic retrieval makes its next query after inspecting search results',async()=>{
  const sources=[{...source,regions:[{id:'r1',text:'The silver key lies in the garden.'},{id:'r2',text:'Alice later carries it beneath the oak.'}]}];
  const snapshot={id:'empty',records:[],rules:[],procedures:[],sources};let calls=0;
  const session={request:async({prompt})=>{calls++;if(prompt.includes('executing agentic retrieval'))return {output:calls===1?{nextQuery:'beneath oak',stop:false,reason:'need location confirmation'}:{nextQuery:'',stop:true,reason:'found location'},usage:{input_tokens:20,output_tokens:3},wallMs:1,sessionId:'mock'};return {output:{answer:'Unresolved',claims:[],citationIds:[],supportState:'unresolved',residuals:['not independently reviewed']},usage:{input_tokens:10,output_tokens:2},wallMs:1,sessionId:'mock'};}};
  const out=await runBaselineRequest({baseline:'agentic-rag',question:{text:'Where is the silver key?'},snapshot,sources,sourceScope:['book-v1'],session,mode:'equal-budget'});
  assert.equal(out.trace.iterations.length,2);assert.equal(out.trace.iterations[0].decision.nextQuery,'beneath oak');
  assert.equal(out.cost.modelRequests,3);assert.equal(out.cost.usage.input_tokens,50);
});

test('GraphRAG builds its reusable index in a separate source-only session',async()=>{
  const docs=makeSourceChunks([{...source,regions:[{id:'r1',text:'Alice holds the silver key in the garden.'},{id:'r2',text:'The gardener sees Alice near the oak.'}]}]);
  const sources=[{...source,regions:[{id:'r1',text:'Alice holds the silver key in the garden.'},{id:'r2',text:'The gardener sees Alice near the oak.'}]}];
  const indexDir=await mkdtemp(join(tmpdir(),'skr-graph-separated-'));let prepCalls=0,answerCalls=0;
  const preprocessingSession={request:async({prompt})=>{prepCalls++;assert.match(prompt,/Extract only explicitly named entities/);return {output:{items:[{id:docs[0].id,entities:['Alice'],relations:[]},{id:docs[1].id,entities:['Gardener'],relations:[]}]},sessionId:'prep',usage:{input_tokens:8},wallMs:1};}};
  const session={request:async({prompt})=>{answerCalls++;assert.match(prompt,/Answer the question/);return {output:{answer:'Alice has the key.',claims:[],citationIds:[],supportState:'unresolved',residuals:[]},sessionId:'answer',usage:{input_tokens:7},wallMs:1};}};
  try{const out=await runBaselineRequest({baseline:'graphrag',question:{text:'What does Alice hold?'},snapshot:{id:'s',sources},sources,sourceScope:['book-v1'],session,preprocessingSession,budget:{graphIndexDir:indexDir,graphExtractionChars:10000,graphExtractionTurns:2}});
    assert.equal(prepCalls,1);assert.equal(answerCalls,1);assert.equal(out.cost.preprocessingUsage.input_tokens,8);assert.equal(out.cost.usage.input_tokens,7);assert.equal(out.cost.preprocessingRequests,1);
  }finally{await rm(indexDir,{recursive:true,force:true});}
});

test('SKR full reuses current procedure assessments with source closure and excludes stale findings',async()=>{
  const s={id:'srcv1',sourceId:'book',sourceVersionId:'srcv1',regions:[{id:'r1',text:'(located_in service:identity region:eu)'}]};
  const snapshot={id:'snap1',sources:[s],records:[
    {id:'fact1',ske:'(located_in service:identity region:eu)',sourceVersionId:'srcv1',regionId:'r1',quote:'(located_in service:identity region:eu)',lifecycle:'current',supportState:'supported',validation:'source-checked'},
    {id:'finding1',type:'procedure-finding',procedureId:'audit',procedureVersion:'2',text:'Assessment: no contradiction observed.',outputType:'no-contradiction',parameters:{scope:'all'},evidenceIds:['fact1'],dependencies:['fact1'],sourceSnapshotId:'snap1',lifecycle:'current',supportState:'unresolved',validation:'model-reviewed'},
    {id:'oldfinding',type:'procedure-finding',procedureId:'audit',procedureVersion:'1',text:'Stale assessment.',evidenceIds:['fact1'],dependencies:['fact1'],lifecycle:'stale',supportState:'unresolved',validation:'model-reviewed'}],
    rules:[],procedures:[{id:'audit',version:'2',active:true}],policy:{}};
  const out=await runBaselineRequest({baseline:'skr-full',question:{text:'Where is identity?',goal:'(located_in service:identity region:eu)'},snapshot,sources:[s],sourceScope:['srcv1']});
  assert.equal(out.trace.materializedFindingCount,1);assert.ok(out.evidence.some(e=>e.id==='finding1'));assert.ok(!out.evidence.some(e=>e.id==='oldfinding'));assert.equal(out.validation.auditStatus,'valid');
});

test('procedure assessment evidence reopens passage IDs and validates source-version dependency pins',async()=>{
  const s={id:'srcv1',sourceId:'book',sourceVersionId:'srcv1',regions:[{id:'r1',text:'The service is in Europe.',locator:{startChar:0,endChar:25}}]};
  const passageId=`passage_${createHash('sha256').update('srcv1:r1').digest('hex').slice(0,24)}`;
  const finding={id:'finding1',type:'procedure-finding',procedureId:'audit',procedureVersion:'2',parameters:{},summary:'A reviewed assessment.',score:null,criterion:null,evidenceIds:[passageId],counterevidenceIds:[],dependencies:[passageId,'srcv1'],sourceSnapshotId:'snap1',lifecycle:'current',supportState:'unresolved',validation:'model-reviewed'};
  const snapshot={id:'snap1',sources:[s],records:[finding],procedures:[{id:'audit',version:'2',active:true}],rules:[]};
  const out=await runBaselineRequest({baseline:'skr-full',question:{text:'Assessment?',goal:'(located_in service europe)'},snapshot,sources:[s],sourceScope:['srcv1']});
  const passage=out.evidence.find(e=>e.id===passageId),citedFinding=out.evidence.find(e=>e.id==='finding1');
  assert.ok(passage);assert.ok(citedFinding);assert.equal(passage.quote,s.regions[0].text);
  const audit=auditEvidence({answerPackage:{supportState:'unresolved',claims:[{text:'assessment',supportState:'unresolved',evidenceIds:['finding1']}]},evidence:out.evidence,snapshot,sourceScope:['srcv1']});
  assert.equal(audit.status,'valid',JSON.stringify(audit.errors));
});

test('procedure reuse requires complete exact-version, exact-parameter coverage over requested source regions',()=>{
  const source={id:'v1',sourceId:'book',sourceVersionId:'v1',regions:[{id:'r1',text:'one'},{id:'r2',text:'two'}]};
  const row=(regionId,state='processed',parameters={topic:'family'})=>({procedureId:'literary',procedureVersion:'2',sourceVersionId:'v1',regionId,state,parameters});
  const full={sources:[source],coverage:[row('r1'),row('r2','intentionally-excluded')]};
  assert.equal(procedureCoverageComplete(full,{procedureId:'literary',procedureVersion:'2',parameters:{topic:'family'},sourceScope:['v1']}),true);
  assert.equal(procedureCoverageComplete({...full,coverage:[row('r1')]},{procedureId:'literary',procedureVersion:'2',parameters:{topic:'family'},sourceScope:['v1']}),false);
  assert.equal(procedureCoverageComplete({...full,coverage:[row('r1'),row('r2','partial')]},{procedureId:'literary',procedureVersion:'2',parameters:{topic:'family'},sourceScope:['v1']}),false);
  assert.equal(procedureCoverageComplete(full,{procedureId:'literary',procedureVersion:'1',parameters:{topic:'family'},sourceScope:['v1']}),false);
  assert.equal(procedureCoverageComplete(full,{procedureId:'literary',procedureVersion:'2',parameters:{topic:'style'},sourceScope:['v1']}),false);
});

test('procedural context never exposes a foreign raw passage through a finding dependency',()=>{
  const local={id:'local-v1',sourceId:'local',sourceVersionId:'local-v1',regions:[{id:'l1',text:'Local source.'}]},foreign={id:'foreign-v1',sourceId:'foreign',sourceVersionId:'foreign-v1',regions:[{id:'f1',text:'Secret foreign passage.'}]};
  const foreignPassage=`passage_${createHash('sha256').update('foreign-v1:f1').digest('hex').slice(0,24)}`;
  const finding={id:'finding',type:'procedure-finding',procedureId:'audit',procedureVersion:'1',summary:'Old finding with malformed cross-project evidence.',dependencies:[foreignPassage],lifecycle:'current',supportState:'unresolved',validation:'model-reviewed'};
  const out=procedureContextEvidence({sources:[local,foreign],records:[finding],procedures:[{id:'audit',version:'1',active:true}]},['local-v1']);
  assert.ok(!out.some(x=>x.sourceVersionId==='foreign-v1'));assert.ok(!out.some(x=>x.id==='finding'));
});

test('span metrics normalize SKE evidence and RAG chunks to the same original offsets across adjacent source regions',()=>{
  const source={id:'v1',sourceVersionId:'v1',regions:[{id:'r1',text:'Once upon a time',locator:{start:100,end:116}},{id:'r2',text:'there were rabbits.',locator:{start:118,end:137}}]},snapshot={sources:[source]};
  const claimEvidence={type:'source',sourceVersionId:'v1',regionId:'r1',quote:'upon a time',locator:{type:'text-line',start:100,end:116}};
  const retrievalChunk={type:'source',sourceVersionId:'v1',regionId:'r1',quote:'upon a time',locator:{startChar:105,endChar:116}};
  assert.deepEqual(normalizeEvidenceSpan(claimEvidence,snapshot),normalizeEvidenceSpan(retrievalChunk,snapshot));
  const multi=mapGoldEvidenceSpans([{sourceVersionId:'v1',regionId:'combined',startChar:114,endChar:123,quote:'time\r\nthere'}],snapshot,['v1']);
  assert.equal(multi.spans.length,2);assert.equal(multi.complete,true);
});

test('duplicate cited intervals do not inflate evidence recall',()=>{
  const half=[{sourceVersionId:'v1',regionId:'r1',start:100,end:105},{sourceVersionId:'v1',regionId:'r1',start:100,end:105}];
  const all=[{sourceVersionId:'v1',regionId:'r2',start:100,end:110}];
  const candidate=unionEvidenceIntervals(half),gold=unionEvidenceIntervals(all);
  assert.equal(evidenceIntersectionLength(gold,candidate)/gold.reduce((n,x)=>n+x.end-x.start,0),.5);
});

test('non-SKR baseline receives the same selected procedure definition and parameters in its answer prompt',async()=>{
  const s={id:'proc-src',sourceId:'proc-src',sourceVersionId:'proc-src',regions:[{id:'r1',text:'Characterization: the narrator describes Peter as naughty.'}]};
  const procedure={id:'literary',version:'1.0.0',purpose:'Assess characterization using exact positive and negative anchors.',applicableInputs:['complete work'],parameters:{criteria:[{id:'characterization',positiveAnchors:['explicit traits'],negativeAnchors:['unsupported motive']}]},orderedSteps:['Identify explicit characterization','Cite counterevidence'],evidenceObligations:['Cite exact source passages']};
  const snapshot={id:'proc-snap',sources:[s],records:[],rules:[],procedures:[procedure]};let plan=false,finalPrompt='';
  const session={request:async({prompt})=>{if(prompt.includes('executing agentic retrieval')){plan=true;return {output:{nextQuery:'Peter naughty',stop:true,reason:'candidate passage located'},sessionId:'luna',usage:{input_tokens:3,output_tokens:1},wallMs:1};}if(prompt.startsWith('Answer the question'))finalPrompt=prompt;return {output:{answer:'Unresolved.',claims:[],citationIds:[],supportState:'unresolved',residuals:['Not verified.']},sessionId:'luna',usage:{input_tokens:4,output_tokens:1},wallMs:1};}};
  await runBaselineRequest({baseline:'agentic-rag',question:{text:'Assess characterization.',procedureId:'literary',procedureVersion:'1.0.0',parameters:{criteria:['characterization']}},snapshot,sources:[s],sourceScope:['proc-src'],session});
  assert.ok(plan);assert.match(finalPrompt,/"id":"literary"/);assert.match(finalPrompt,/"version":"1\.0\.0"/);assert.match(finalPrompt,/characterization/);assert.match(finalPrompt,/unsupported motive/);
});
