import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { match, parseSKE, printSKE } from './index.mjs';
import { reviewAssertions } from '../ingestion/index.mjs';
import { searchSources } from '../query/index.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clone = x => structuredClone(x);
const sourceVersion = s => s.sourceVersionId ?? s.id;
const inScope = (s, scope) => !scope || scope.includes(s.id) || scope.includes(sourceVersion(s)) || scope.includes(s.sourceId);
const groundCall = ske => {
  const ast = typeof ske === 'string' ? parseSKE(ske) : ske;
  if (ast?.type !== 'call' || JSON.stringify(ast).includes('"type":"variable"')) throw new Error('Expected a ground SKE predicate call');
  return printSKE(ast);
};
const queryGoal = value => {
  const ast = typeof value === 'string' ? parseSKE(value) : value;
  if (!ast || !['call','and','find'].includes(ast.type)) throw new Error('Expected a SKE query');
  return printSKE(ast);
};

// Retrieval/interpretation aid only: every listed assertion is already authorized
// inside the selected source scope. This vocabulary never supplies evidence itself.
function scopedSemanticCatalog(records) {
  const predicates = new Map(), entities = new Map();
  const visit = ast => {
    if (!ast || typeof ast !== 'object') return;
    if (ast.type === 'call') {
      const entry = predicates.get(ast.predicate) ?? { predicate: ast.predicate, arities: new Set(), examples: [] };
      entry.arities.add(ast.args.length);
      if (entry.examples.length < 4) entry.examples.push(printSKE(ast));
      predicates.set(ast.predicate, entry);
      for (const arg of ast.args) visit(arg);
    } else if (ast.type === 'and') for (const term of ast.terms) visit(term);
    else if (ast.type === 'find') visit(ast.body);
  };
  for (const record of records) {
    try { visit(parseSKE(typeof record.ske === 'string' ? record.ske : printSKE(record.ske))); } catch {}
    for (const mention of record.entityMentions ?? []) {
      if (!mention.entityId || mention.decision === 'ambiguous') continue;
      const entry = entities.get(mention.entityId) ?? { entityId: mention.entityId, canonicalName: mention.canonicalName ?? mention.surface, aliases: new Set() };
      if (mention.surface) entry.aliases.add(mention.surface);
      if (mention.canonicalName) entry.aliases.add(mention.canonicalName);
      entities.set(mention.entityId, entry);
    }
  }
  return {
    predicates: [...predicates.values()].map(p => ({ predicate:p.predicate, arities:[...p.arities].sort((a,b)=>a-b), authorizedExamples:p.examples })),
    entities: [...entities.values()].map(e => ({ entityId:e.entityId, canonicalName:e.canonicalName, aliases:[...e.aliases] }))
  };
}

async function writeCheckpoint(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, file);
}

const INTERPRET_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['goal', 'scope', 'reasoningNotes'],
  properties: {
    goal: { type: ['string', 'null'] },
    scope: { type: 'object', additionalProperties: false, required: ['attribution','time','modality','polarity','world'], properties: {
      attribution: { type: ['string','null'] }, time: { type: ['string','null'] }, modality: { type: ['string','null'] }, polarity: { type: ['string','null'] }, world: { type: ['string','null'] }
    } },
    reasoningNotes: { type: 'string' }
  }
};

function proposalSchema(regionIds) {
  return { type:'object',additionalProperties:false,required:['proposals','subgoals','uncertainties'],properties:{
    proposals:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,required:['ske','sourceVersionId','regionId','quote','qualifiers','entities','why'],properties:{
      ske:{type:'string',minLength:3},sourceVersionId:{type:'string'},regionId:{type:'string',enum:regionIds},quote:{type:'string',minLength:1},
      qualifiers:{type:'object',additionalProperties:false,required:['attribution','time','modality','polarity','world'],properties:{attribution:{type:['string','null']},time:{type:['string','null']},modality:{type:['string','null']},polarity:{type:['string','null']},world:{type:['string','null']}}},
      entities:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['surface','canonicalName','kind'],properties:{surface:{type:'string'},canonicalName:{type:['string','null']},kind:{type:['string','null']}}}},why:{type:'string'}
    }}},
    subgoals:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['goal','reason'],properties:{goal:{type:'string'},reason:{type:'string'}}}},
    uncertainties:{type:'array',maxItems:12,items:{type:'string'}}
  }};
}

function residual(goal, reason, extra = {}) { return { goal: typeof goal === 'string' ? goal : goal ? printSKE(goal) : null, reason, ...extra }; }

/**
 * Bounded goal-directed semantic retrieval. Natural-language outputs never become facts directly:
 * candidate source claims pass through the independent ingestion reviewer and remain ephemeral.
 * The returned ledger/checkpoint can be resumed only against the same pinned snapshot and scope.
 */
export async function resolveSemantics({ question, goal, scope, snapshot, sourceScope, session, checkpointDir, signal, onEvent, procedures = [], maxIterations = 4, maxHits = 8, rootDir } = {}) {
  if (!snapshot?.id || !Array.isArray(snapshot.sources) || !session?.request || !checkpointDir) throw new TypeError('Pinned snapshot, scope, Luna session, and checkpointDir are required');
  const scopedSources=snapshot.sources.filter(s=>inScope(s,sourceScope));
  const selectedVersionIds=new Set(scopedSources.map(sourceVersion));
  if (!Array.isArray(sourceScope) || sourceScope.some(id=>!selectedVersionIds.has(id)) || scopedSources.length!==new Set(sourceScope).size) throw new Error('Source scope must name only versions in the pinned snapshot');
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 8 || !Number.isInteger(maxHits) || maxHits < 1 || maxHits > 20) throw new RangeError('Semantic resolution bounds are invalid');
  const fingerprint = hash({ snapshotId:snapshot.id, sourceScope:[...sourceScope].sort(), question:String(question??''), goal:goal??null, scope:scope??null, procedures:procedures.map(p=>[p.id,p.version]) });
  const checkpointFile = path.join(checkpointDir, 'semantic-resolution.json');
  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
    if (checkpoint.fingerprint !== fingerprint) throw new Error('Semantic-resolution checkpoint does not match pinned request');
  } catch (e) { if (e.code !== 'ENOENT') throw e; checkpoint = { version:1, fingerprint, snapshotId:snapshot.id, sourceScope:[...sourceScope], question:String(question??''), ledger:{iterations:[],agenda:[],residuals:[],bindings:[]}, reviewedRecords:[], reviewReceipts:[], createdAt:new Date().toISOString() }; }

  const allRecords=snapshot.records??[], byId=new Map(allRecords.map(r=>[r.id,r])), authorized=new Set();
  for(const r of allRecords)if(r.sourceVersionId&&(sourceScope.includes(r.sourceVersionId)||sourceScope.includes(r.sourceId))&&(!r.dependencies?.length))authorized.add(r.id);
  let grew=true;while(grew){grew=false;for(const r of allRecords)if(!authorized.has(r.id)&&r.dependencies?.length&&(!r.sourceVersionId||(sourceScope.includes(r.sourceVersionId)||sourceScope.includes(r.sourceId)))&&r.dependencies.every(id=>authorized.has(id))){authorized.add(r.id);grew=true;}}
  const scopedRecords = allRecords.filter(r => !['stale','retracted','superseded','staged'].includes(r.lifecycle) && authorized.has(r.id));
  const ephemeral = checkpoint.reviewedRecords ?? [];
  let semanticCatalog = scopedSemanticCatalog([...scopedRecords, ...ephemeral]);
  let parsedGoal = goal ? queryGoal(goal) : (checkpoint.goal ? queryGoal(checkpoint.goal) : null), interpretedScope = scope ?? checkpoint.scope ?? null;
  const cost={queryUsage:{},modelRequests:0,wallMs:0,promptChars:0};
  const account=(result,prompt)=>{cost.modelRequests++;cost.wallMs+=Number(result?.wallMs)||0;cost.promptChars+=String(prompt??'').length;for(const [k,v]of Object.entries(result?.usage??{}))cost.queryUsage[k]=(Number(cost.queryUsage[k])||0)+(Number(v)||0);};
  if (!parsedGoal) {
    const prompt=`Interpret the user's question as one precise ground or variable-bearing SKE goal when possible. Preserve requested attribution, time, modality, polarity, and world; use null when the question does not specify them. Do not answer from prior knowledge. SKE grammar uses parenthesized, predicate-first whitespace-separated forms, e.g. (count rabbits ?n), (and (owns ?x rabbit) (located_in ?x forest)); never function syntax. Prefer an existing predicate and canonical entity from the authorized catalog when its argument roles and meaning fit the question. Treat surface phrases such as “little rabbits” as possible aliases/descriptions, not automatically as a new entity or predicate. Keep direction and argument roles exactly as shown by examples; do not rename roles to force a match. The catalog is vocabulary only, not proof. If no defensible goal exists, set goal null and explain in reasoningNotes.\nQuestion: ${String(question??'')}\nAuthorized scoped semantic catalog: ${JSON.stringify(semanticCatalog)}\nPinned source names: ${JSON.stringify(snapshot.sources.filter(s=>inScope(s,sourceScope)).map(s=>s.name))}`;
    const interpretation = await session.request({ signal, schema:INTERPRET_SCHEMA, prompt });account(interpretation,prompt);
    if (typeof interpretation.output?.goal === 'string') { try { parsedGoal = queryGoal(interpretation.output.goal); } catch { parsedGoal = null; } }
    interpretedScope = interpretation.output?.scope ?? null;
    checkpoint.goal = parsedGoal; checkpoint.scope = interpretedScope; checkpoint.interpretationSessionId = interpretation.sessionId;
    await writeCheckpoint(checkpointFile, checkpoint);
  } else parsedGoal = queryGoal(parsedGoal);
  if(scope) interpretedScope=scope;

  const agenda = checkpoint.ledger.agenda ?? [];
  if (!agenda.length && parsedGoal) agenda.push({ goal:parsedGoal, depth:0, reason:'user-question', status:'pending' });
  else if (!parsedGoal) agenda.push({ goal:null, depth:0, reason:'question-could-not-be-interpreted', status:'residual' });
  for (const item of agenda) if (item.status==='running') item.status='pending';
  checkpoint.goal=parsedGoal;checkpoint.scope=interpretedScope;checkpoint.ledger.agenda=agenda;await writeCheckpoint(checkpointFile,checkpoint);
  let finalMatches = [], residuals = [...(checkpoint.ledger.residuals ?? [])], evidence = [], allReceipts = [...(checkpoint.reviewReceipts ?? [])];
  const seenGoals = new Set([...(checkpoint.ledger.iterations.map(x=>x.goal).filter(Boolean)),...agenda.map(x=>x.goal).filter(Boolean)]);
  for (const item of agenda) if (item.status !== 'residual' && item.goal) {
    try { const initial = match(parseSKE(item.goal), [...scopedRecords,...ephemeral], { sourceScope, scope:interpretedScope ?? undefined }); if ((initial.matches ?? []).some(m=>['equivalent','contested'].includes(m.relation))) item.status='matched'; }
    catch { /* malformed saved agenda is handled below as a residual */ }
  }
  for (let iteration = checkpoint.ledger.iterations.length; iteration < maxIterations && agenda.some(a=>a.status==='pending'); iteration++) {
    if (signal?.aborted) throw signal.reason ?? new Error('Semantic resolution aborted');
    const item = agenda.find(a=>a.status==='pending'); item.status='running';
    checkpoint.ledger.agenda=agenda;await writeCheckpoint(checkpointFile,checkpoint);
    let goalAst; try { goalAst=parseSKE(item.goal); } catch { item.status='residual'; residuals.push(residual(item.goal,'goal is not valid SKE')); continue; }
    const structural = match(goalAst, [...scopedRecords,...ephemeral], { sourceScope, scope:interpretedScope ?? undefined });
    if ((structural.matches ?? []).some(m=>m.relation==='equivalent'||m.relation==='contested')) {
      item.status='matched'; checkpoint.ledger.iterations.push({goal:item.goal,method:'structural',matchCount:structural.matches.length});
      await writeCheckpoint(checkpointFile,checkpoint); continue;
    }
    const lexical = await searchSources({ snapshot, query:`${String(question??'')} ${item.goal}`, sourceScope, topK:maxHits, rootDir });
    const regionIds = lexical.hits.map(h=>h.regionId), regions = new Map();
    for (const source of snapshot.sources.filter(s=>inScope(s,sourceScope))) for (const region of source.regions??[]) if(regionIds.includes(region.id)) regions.set(`${sourceVersion(source)}:${region.id}`,{source,region});
    const hits = lexical.hits.map(h=> { const src=snapshot.sources.find(s=>sourceVersion(s)===h.sourceVersionId);return {...h,sourceId:src?.sourceId}; });
    if (!hits.length) { item.status='residual'; const r=residual(item.goal,'scoped lexical retrieval found no source passages'); residuals.push(r); checkpoint.ledger.iterations.push({goal:item.goal,method:'retrieval',hits:0}); await writeCheckpoint(checkpointFile,checkpoint); continue; }
    const knownEntities=[...ephemeral.flatMap(r=>r.entityMentions??[])];
    const prompt=`Advance this semantic goal using only the exact pinned source passages supplied. Propose direct source claims only when quote text entails them; source claims will receive a separate independent review, so do not answer or infer facts. Suggest relation-direction clarification or smaller SKE subgoals only when they would help. Preserve modalities, polarity, time, attribution, world. Cite both sourceVersionId and regionId exactly and quote verbatim. Do not propose facts from names/co-occurrence alone. Reuse authorized predicate signatures, examples, and canonical entities when semantically aligned; do not force a role mapping or relation direction that the evidence does not support. The catalog is vocabulary only, never evidence.\nQuestion: ${String(question??'')}\nRoot goal: ${checkpoint.goal ?? goal ?? item.goal}\nCurrent goal: ${item.goal}\nAuthorized scoped semantic catalog: ${JSON.stringify(semanticCatalog)}\nBound variables: ${JSON.stringify(checkpoint.ledger.bindings)}\nCurrent unresolved residuals: ${JSON.stringify(residuals)}\nKnown reviewed entity identities: ${JSON.stringify(knownEntities)}\nHits: ${JSON.stringify(hits.map(({sourceVersionId,regionId,quote,locator,fidelityCaveat})=>({sourceVersionId,regionId,quote,locator,fidelityCaveat})))}\nReturn grounded proposals, useful subgoals, and uncertainties.`;
    const proposed = await session.request({signal,schema:proposalSchema(regionIds),prompt});account(proposed,prompt);
    const output=proposed.output??{}; const candidates=[];
    for(let i=0;i<(output.proposals??[]).length;i++) {
      const p=output.proposals[i], hit=hits.find(h=>h.regionId===p.regionId&&h.sourceVersionId===p.sourceVersionId); if(!hit) continue;
      try { candidates.push({candidateId:`sem_${hash(`${fingerprint}:${iteration}:${i}:${p.regionId}:${p.ske}`).slice(0,24)}`,ske:groundCall(p.ske),sourceVersionId:hit.sourceVersionId,sourceId:hit.sourceId,regionId:p.regionId,quote:p.quote,qualifiers:p.qualifiers,entities:p.entities}); } catch {}
    }
    let review={records:[],receipts:[],rejected:[],sessionId:null};
    if(candidates.length) { const reviewSnapshot={...snapshot,records:[...allRecords,...ephemeral]};review=await reviewAssertions({candidates,snapshot:reviewSnapshot,sourceScope,session,signal,onEvent});cost.modelRequests+=Number(review.calls)||0;cost.wallMs+=Number(review.wallMs)||0;for(const[k,v]of Object.entries(review.usage??{}))cost.queryUsage[k]=(Number(cost.queryUsage[k])||0)+(Number(v)||0); }
    const newIds=new Set(ephemeral.map(r=>r.id));
    for(const r of review.records??[]) if(!newIds.has(r.id)){ephemeral.push(clone(r));newIds.add(r.id);}
    semanticCatalog = scopedSemanticCatalog([...scopedRecords, ...ephemeral]);
    checkpoint.reviewedRecords=ephemeral; checkpoint.reviewReceipts=[...allReceipts,...(review.receipts??[])]; allReceipts.push(...(review.receipts??[]));
    const reviewedMatches=match(goalAst,[...scopedRecords,...ephemeral],{sourceScope,scope:interpretedScope??undefined});
    const unresolvedSubgoals=[];
    for(const sub of output.subgoals??[]) {
      let subgoal;try{subgoal=queryGoal(sub.goal);}catch{residuals.push(residual(sub.goal,'proposed subgoal is invalid SKE',{parentGoal:item.goal}));continue;}
      if(!seenGoals.has(subgoal)&&agenda.filter(a=>a.status==='pending').length<10){seenGoals.add(subgoal);agenda.push({goal:subgoal,depth:item.depth+1,reason:String(sub.reason??'model-proposed subgoal'),status:'pending'});unresolvedSubgoals.push(subgoal);}
    }
    item.status=(reviewedMatches.matches??[]).some(m=>['equivalent','contested'].includes(m.relation))?'matched':'searched';
    for(const uncertainty of output.uncertainties??[]) residuals.push(residual(item.goal,String(uncertainty),{kind:'model-uncertainty'}));
    for(const r of review.rejected??[]) residuals.push(residual(item.goal,`source candidate not promoted: ${r.reason}`,{candidateId:r.candidateId}));
    checkpoint.ledger.iterations.push({goal:item.goal,method:'scoped-retrieval-and-review',hits:hits.length,candidates:candidates.length,accepted:(review.records??[]).length,rejected:(review.rejected??[]).length,subgoals:unresolvedSubgoals,sessionId:proposed.sessionId});
    if(!(reviewedMatches.matches??[]).length&&!unresolvedSubgoals.length) residuals.push(residual(item.goal,'no reviewed source assertion structurally satisfied this goal'));
    checkpoint.ledger.bindings=(match(parseSKE(checkpoint.goal),[...scopedRecords,...ephemeral],{sourceScope,scope:interpretedScope??undefined}).bindings??[]);
    checkpoint.ledger.residuals=[...new Map(residuals.map(r=>[JSON.stringify(r),r])).values()];checkpoint.ledger.agenda=agenda;
    await writeCheckpoint(checkpointFile,checkpoint);
    onEvent?.({type:'semantic-resolution.iteration',iteration:checkpoint.ledger.iterations.length,goal:item.goal,hits:hits.length,accepted:(review.records??[]).length,sessionId:proposed.sessionId});
  }
  for(const item of agenda)if(item.status==='pending'){item.status='residual';residuals.push(residual(item.goal,'bounded semantic-resolution iteration limit reached'));}
  const rootMatches=parsedGoal?match(parseSKE(parsedGoal),[...scopedRecords,...ephemeral],{sourceScope,scope:interpretedScope??undefined}):{matches:[]};
  finalMatches=rootMatches.matches??[];
  const uniqueMatches=[...new Map(finalMatches.map(m=>[`${m.relation}:${JSON.stringify(m.bindings)}:${(m.evidenceIds??[]).join(',')}`,m])).values()];
  const claims=uniqueMatches.map(m=>({text:printSKE(parseSKE(checkpoint.goal??goal??'(unresolved)')),goal:checkpoint.goal??goal??null,bindings:m.bindings??{},evidenceIds:m.evidenceIds??[],supportState:m.relation==='equivalent'?'supported':m.relation==='contested'?'contested':'unresolved',validation:'structural-match'}));
  for(const id of new Set(uniqueMatches.flatMap(m=>m.evidenceIds??[]))){const r=[...scopedRecords,...ephemeral].find(x=>x.id===id);if(!r)continue;const s=snapshot.sources.find(x=>sourceVersion(x)===r.sourceVersionId);const region=s?.regions?.find(x=>x.id===r.regionId);if(region)evidence.push({id:r.id,type:'source',sourceVersionId:r.sourceVersionId,regionId:r.regionId,quote:region.text,locator:region.locator,ske:r.ske,qualifiers:r.qualifiers,ephemeral:!scopedRecords.some(x=>x.id===r.id)});}
  const supported=uniqueMatches.some(m=>m.relation==='equivalent'),contested=uniqueMatches.some(m=>m.relation==='contested');
  checkpoint.ledger.agenda=agenda;checkpoint.ledger.residuals=[...new Map(residuals.map(r=>[JSON.stringify(r),r])).values()];checkpoint.ledger.bindings=uniqueMatches.map(m=>m.bindings??{});checkpoint.updatedAt=new Date().toISOString();await writeCheckpoint(checkpointFile,checkpoint);
  const residualSet=checkpoint.ledger.residuals;
  const answer=supported?claims.filter(c=>c.supportState==='supported').map(c=>c.text).join('\n'):contested?`Contested: ${checkpoint.goal??String(question??'')}`:`Unresolved: ${String(question??'')}`;
  return {answerPackage:{answer,claims,interpretation:'Goal-directed Luna interpretation with scoped retrieval and independent source-assertion review.',supportState:contested?'contested':supported?'supported':'unresolved',scope:interpretedScope,coverage:{iterations:checkpoint.ledger.iterations.length,scopedSources:sourceScope.length,reviewedCandidates:ephemeral.length},procedureVersions:procedures.map(p=>({id:p.id,version:p.version})),snapshotId:snapshot.id,residuals:clone(residualSet)},evidence:clone(evidence),ephemeralRecords:clone(ephemeral),candidates:clone(ephemeral),reviewReceipts:clone(allReceipts),ledger:clone(checkpoint.ledger),checkpoint:{path:checkpointFile,fingerprint,status:agenda.some(a=>a.status==='pending')?'partial':'complete'},cost,validation:{status:supported?'supported':contested?'contested':'unresolved',deterministicStructuralMatch:true,sourceReview:'model-reviewed',humanReview:false}};
}
