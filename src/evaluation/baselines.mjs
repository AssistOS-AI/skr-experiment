import { performance } from 'node:perf_hooks';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { embedTexts, cosine, rerankPairs, MODEL_LOCK } from './local-models.mjs';
import { match, resolve as resolveSKR, reason, auditEvidence, parseSKE, printSKE } from '../engine/index.mjs';
import { resolveSemantics } from '../engine/semantic-resolution.mjs';
import { reviewFingerprint, procedureReviewFingerprint } from '../ingestion/receipts.mjs';
import { materializeProcedures } from '../ingestion/index.mjs';
import { priceUsage } from './pricing.mjs';

export const BASELINE_IDS=['hybrid-rag','agentic-rag','graphrag','full-source-agent','skr-direct','skr-full'];
const STOP=new Set('the a an and or but of to in on at for from with by as is are was were be been being this that these those it its he she they them their his her you your we our what which who when where how why does did do into out up down then than if because while after before over under about not yes no'.split(' '));
const words=s=>(String(s).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g)??[]).filter(w=>w.length>1&&!STOP.has(w));
const idSafe=s=>String(s).replace(/[^A-Za-z0-9_-]/g,'_');
function addUsage(...items){const out={};for(const item of items.filter(Boolean)){for(const [k,v] of Object.entries(item)){if(typeof v==='number'&&Number.isFinite(v))out[k]=(out[k]??0)+v;else if(v&&typeof v==='object'&&!Array.isArray(v))out[k]=addUsage(out[k]??{},v);}}return Object.keys(out).length?out:null;}

export function procedureCoverageComplete(snapshot,{procedureId,procedureVersion,parameters={},sourceScope}={}) {
  const sources=(snapshot?.sources??[]).filter(s=>!sourceScope||sourceScope.includes(s.sourceVersionId??s.id)||sourceScope.includes(s.sourceId)||sourceScope.includes(s.id));
  if(!sources.length)return false;
  const rows=(snapshot.coverage??[]).filter(c=>c.procedureId===procedureId&&String(c.procedureVersion)===String(procedureVersion)&&JSON.stringify(c.parameters??{})===JSON.stringify(parameters??{}));
  if(!rows.length)return false;
  for(const source of sources){const version=source.sourceVersionId??source.id;const applicable=rows.filter(c=>c.sourceVersionId===version);if(applicable.some(c=>!['processed','intentionally-excluded'].includes(c.state)))return false;
    for(const region of source.regions??[]){const row=applicable.find(c=>c.regionId===region.id);if(!row||!['processed','intentionally-excluded'].includes(row.state))return false;}
  }
  return true;
}

export function normalizeEvidenceSpan(evidence,snapshot,defaultSourceVersionId) {
  if(evidence?.type!=='source'||!evidence.regionId)return null;
  const version=evidence.sourceVersionId??defaultSourceVersionId,source=(snapshot?.sources??[]).find(s=>(s.sourceVersionId??s.id)===version);if(!source)return null;
  const region=(source.regions??[]).find(r=>r.id===evidence.regionId);if(!region)return null;
  const quote=typeof evidence.quote==='string'?evidence.quote:null,locator=evidence.locator??{};
  if(Number.isFinite(locator.startChar)&&Number.isFinite(locator.endChar)&&(!quote||locator.endChar-locator.startChar===quote.length))return {sourceVersionId:version,regionId:region.id,start:locator.startChar,end:locator.endChar};
  const base=Number(locator.start??locator.sourceStartChar??region.locator?.start??region.locator?.sourceStartChar);
  if(quote){const at=region.text.indexOf(quote);if(at>=0&&Number.isFinite(base))return {sourceVersionId:version,regionId:region.id,start:base+at,end:base+at+quote.length};}
  const start=Number(locator.startChar??locator.start??locator.sourceStartChar),end=Number(locator.endChar??locator.end??locator.sourceEndChar);return Number.isFinite(start)&&Number.isFinite(end)&&end>start?{sourceVersionId:version,regionId:region.id,start,end}:null;
}

export function mapGoldEvidenceSpans(goldEvidence,snapshot,sourceScope) {
  const mapped=[];let complete=true;
  for(const e of goldEvidence??[]){const version=e.sourceVersionId??sourceScope?.[0],source=(snapshot?.sources??[]).find(s=>(s.sourceVersionId??s.id)===version);if(!source){complete=false;continue;}
    const start=Number(e.startChar),end=Number(e.endChar),quote=String(e.quote??'');let targets=(source.regions??[]).filter(r=>r.id===e.regionId);if(!targets.length&&Number.isFinite(start)&&Number.isFinite(end))targets=(source.regions??[]).filter(r=>{const base=Number(r.locator?.start??r.locator?.sourceStartChar),finish=Number(r.locator?.end??r.locator?.sourceEndChar);return Number.isFinite(base)&&Number.isFinite(finish)&&base<end&&finish>start;});
    if(!targets.length&&quote){const region=(source.regions??[]).find(r=>r.text.includes(quote));if(region)targets=[region];}
    if(!targets.length){complete=false;continue;}
    let found=false;for(const region of targets){const base=Number(region.locator?.start??region.locator?.sourceStartChar);if(Number.isFinite(start)&&Number.isFinite(end)&&Number.isFinite(base)){const lo=Math.max(start,base),hi=Math.min(end,base+region.text.length);if(hi>lo){mapped.push({sourceVersionId:version,regionId:region.id,start:lo,end:hi});found=true;continue;}}
      if(quote){const at=region.text.indexOf(quote);if(at>=0&&Number.isFinite(base)){mapped.push({sourceVersionId:version,regionId:region.id,start:base+at,end:base+at+quote.length});found=true;}}
    }if(!found)complete=false;
  }
  return {spans:mapped,complete:complete&&mapped.length>0};
}

export function unionEvidenceIntervals(spans) {
  const bySource=new Map();
  for(const span of spans??[]){if(!span?.sourceVersionId||!Number.isFinite(span.start)||!Number.isFinite(span.end)||span.end<=span.start)continue;const list=bySource.get(span.sourceVersionId)??[];list.push({start:span.start,end:span.end});bySource.set(span.sourceVersionId,list);}
  const merged=[];for(const [sourceVersionId,list] of bySource){list.sort((a,b)=>a.start-b.start||a.end-b.end);let current=null;for(const item of list){if(current&&item.start<=current.end)current.end=Math.max(current.end,item.end);else{if(current)merged.push({sourceVersionId,...current});current={...item};}}if(current)merged.push({sourceVersionId,...current});}return merged;
}
export function evidenceIntersectionLength(left,right){let total=0;for(const a of left??[])for(const b of right??[])if(a.sourceVersionId===b.sourceVersionId)total+=Math.max(0,Math.min(a.end,b.end)-Math.max(a.start,b.start));return total;}

export function makeSourceChunks(sources,{maxChars=1400}={}) {
  const output=[];
  for(const source of sources??[]) {
    const sourceVersionId=source.sourceVersionId??source.id;
    const sourceId=source.sourceId??source.id;
    const regions=source.regions?.length?source.regions:[{id:'full-text',text:source.content??''}];
    for(const region of regions) {
      const original=String(region.text??'');let part=0;
      for(const paragraph of original.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)) {
        const raw=paragraph[0], leading=raw.search(/\S/), base=paragraph.index+leading, value=raw.trim();let cursor=0;
        while(cursor<value.length) {
          let end=Math.min(value.length,cursor+maxChars);
          if(end<value.length){const boundary=value.lastIndexOf(' ',end);if(boundary>cursor+maxChars*0.55)end=boundary;}
          const text=value.slice(cursor,end).trim();if(text) {
            const localStart=value.indexOf(text,cursor), coordinateBase=Number(region.locator?.sourceStartChar??region.locator?.start??0), startChar=coordinateBase+base+localStart, endChar=startChar+text.length;
            output.push({id:`chunk_${idSafe(sourceVersionId)}_${idSafe(region.id)}_${part++}`,sourceId,sourceVersionId,regionId:region.id,parentRegionId:region.id,locator:{...(typeof region.locator==='object'?region.locator:{}),startChar,endChar},startChar,endChar,text});
            cursor=end;
          } else cursor=end+1;
        }
      }
    }
  }
  return output;
}

export function bm25Search(query,documents,{topK=10,k1=1.2,b=0.75}={}) {
  const q=[...new Set(words(query))], n=documents.length;
  if(!n||!q.length)return [];
  const tokenized=documents.map(d=>words(d.text)), df=new Map();
  for(const terms of tokenized)for(const term of new Set(terms))df.set(term,(df.get(term)??0)+1);
  const avg=tokenized.reduce((s,x)=>s+x.length,0)/n;
  return documents.map((d,i)=>{
    const ts=tokenized[i],counts=new Map(); for(const x of ts)counts.set(x,(counts.get(x)??0)+1);
    const score=q.reduce((sum,term)=>{const f=counts.get(term)??0;if(!f)return sum;const idf=Math.log(1+(n-(df.get(term)??0)+0.5)/((df.get(term)??0)+0.5));return sum+idf*f*(k1+1)/(f+k1*(1-b+b*ts.length/(avg||1)));},0);
    return {...d,lexicalScore:score};
  }).filter(d=>d.lexicalScore>0).sort((a,b)=>b.lexicalScore-a.lexicalScore).slice(0,topK);
}

const embeddingCache=new WeakMap();
const persistentEmbeddingCache=new Map();
const documentFingerprint=docs=>createHash('sha256').update(JSON.stringify([MODEL_LOCK.embedding.id,MODEL_LOCK.embedding.revision,docs.map(d=>[d.id,d.text])])).digest('hex');
export async function buildHybridIndex(documents) {
  const started=performance.now(), dense=await embedTexts(documents.map(d=>d.text));
  const index={vectors:dense,documentIds:documents.map(d=>d.id),model:MODEL_LOCK.embedding,buildWallMs:performance.now()-started,documentEmbeddingCalls:documents.length};
  embeddingCache.set(documents,index);return index;
}
export async function hybridSearch(query,documents,{topK=10,rerankK=12,index:providedIndex,indexDir}={}) {
  const started=performance.now();
  const key=documentFingerprint(documents);let cached=providedIndex??persistentEmbeddingCache.get(key)??embeddingCache.get(documents),indexReused=Boolean(cached);
  const cachePath=indexDir?join(indexDir,`hybrid-${key}.json`):null;
  if(!cached&&cachePath){try{const saved=JSON.parse(await readFile(cachePath,'utf8'));if(saved.fingerprint===key&&saved.documentIds.join('\0')===documents.map(d=>d.id).join('\0')){cached={...saved,vectors:saved.vectors.map(v=>Float32Array.from(v)),buildWallMs:0,documentEmbeddingCalls:0,persisted:true};indexReused=true;}}catch{}}
  if(!cached){cached=await buildHybridIndex(documents);if(cachePath){await mkdir(indexDir,{recursive:true});const temp=`${cachePath}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify({fingerprint:key,documentIds:cached.documentIds,model:cached.model,vectors:cached.vectors.map(v=>Array.from(v))}),{flag:'wx',mode:0o600});await import('node:fs/promises').then(fs=>fs.rename(temp,cachePath));} }
  persistentEmbeddingCache.set(key,cached);embeddingCache.set(documents,cached);
  const [qvec]=await embedTexts([query]);
  const lexical=bm25Search(query,documents,{topK:Math.max(topK*4,rerankK)}), lexRank=new Map(lexical.map((d,i)=>[d.id,i+1]));
  const sem=documents.map((d,i)=>({...d,denseScore:cosine(qvec,cached.vectors[i])})).sort((a,b)=>b.denseScore-a.denseScore).slice(0,Math.max(topK*4,rerankK));
  const semRank=new Map(sem.map((d,i)=>[d.id,i+1]));
  const candidates=new Map([...lexical,...sem].map(d=>[d.id,d]));
  const fused=[...candidates.values()].map(d=>({...d,fusionScore:(1/(60+(lexRank.get(d.id)??10000)))+(1/(60+(semRank.get(d.id)??10000)))})).sort((a,b)=>b.fusionScore-a.fusionScore).slice(0,rerankK);
  const raw=await rerankPairs(query,fused.map(d=>d.text));
  const hits=fused.map((d,i)=>({...d,rerankerScore:raw[i]})).sort((a,b)=>b.rerankerScore-a.rerankerScore).slice(0,topK);
  return {hits,cost:{embeddingModel:MODEL_LOCK.embedding,rerankerModel:MODEL_LOCK.reranker,documentEmbeddingCalls:indexReused?0:documents.length,queryEmbeddingCalls:1,rerankerPairs:fused.length,indexBuildWallMs:indexReused?0:cached.buildWallMs??0,indexReused,wallMs:performance.now()-started,modelTokens:null,modelDollarCost:null}};
}

function louvainCommunities(nodes,edgeMap) {
  const ids=[...nodes.keys()].sort(), adjacency=new Map(ids.map(id=>[id,new Map()]));let m2=0;
  for(const [key,weight] of edgeMap){const [a,b]=key.split('\0');if(a===b)continue;adjacency.get(a)?.set(b,weight);adjacency.get(b)?.set(a,weight);m2+=2*weight;}
  if(!m2)return ids.map((id,i)=>({id:`community_${i+1}`,entities:[id]}));
  let community=new Map(ids.map(id=>[id,id])), degree=new Map(ids.map(id=>[id,[...adjacency.get(id).values()].reduce((a,b)=>a+b,0)]));
  for(let pass=0;pass<20;pass++){let changed=false;
    for(const node of ids){const from=community.get(node), ki=degree.get(node), totals=new Map();
      for(const [neighbor,w] of adjacency.get(node)){const c=community.get(neighbor);totals.set(c,(totals.get(c)??0)+w);}
      let best=from,bestGain=0;
      for(const [candidate,kiIn] of totals){const tot=[...ids].reduce((sum,id)=>sum+(community.get(id)===candidate?degree.get(id):0),0);const gain=kiIn-(ki*tot/m2);if(gain>bestGain+1e-9||(Math.abs(gain-bestGain)<=1e-9&&candidate<best)){best=candidate;bestGain=gain;}}
      if(best!==from){community.set(node,best);changed=true;}
    }
    if(!changed)break;
  }
  const groups=new Map();for(const id of ids){const c=community.get(id);if(!groups.has(c))groups.set(c,[]);groups.get(c).push(id);}
  return [...groups.values()].sort((a,b)=>a[0].localeCompare(b[0])).map((entities,i)=>({id:`community_${i+1}`,entities}));
}

const GRAPH_SCHEMA={type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',items:{type:'object',additionalProperties:false,required:['id','entities','relations'],properties:{id:{type:'string'},entities:{type:'array',items:{type:'string'}},relations:{type:'array',items:{type:'object',additionalProperties:false,required:['subject','predicate','object'],properties:{subject:{type:'string'},predicate:{type:'string'},object:{type:'string'}}}}}}}}};
async function graphIndex(documents,{session,signal,maxExtractionChars=12000,maxExtractionTurns=1000,indexDir=join(process.cwd(),'artifacts','graphrag-indexes')}={}) {
  const batchProfile={maxDocuments:32,maxPromptChars:12000};
  const profile=session?`gpt-6-luna-entity-relation-v1:${session.isMock===true||session.mock===true?'mock':'live'}`:'offline-titlecase-cooccurrence-v1';
  const fingerprint=createHash('sha256').update(JSON.stringify({documents:documents.map(d=>[d.id,d.sourceVersionId,d.regionId,d.startChar,d.endChar,d.text]),profile,modelRevision:'gpt-6-luna',maxExtractionChars,maxExtractionTurns,batchProfile,summaryProfile:'relation-extractive-v1',communityMethod:'weighted-louvain-local-modularity-v1'})).digest('hex'),cachePath=join(indexDir,`graph-${fingerprint}.json`);
  try{const saved=JSON.parse(await readFile(cachePath,'utf8'));if(saved.fingerprint===fingerprint)return {...saved,docEntities:new Map(Object.entries(saved.docEntities)),cacheHit:true,observedExtractionUsage:null,observedExtractionTurns:0,observedExtractionWallMs:0,observedExtractionPromptChars:0,buildWallMs:0};}catch{}
  const buildStarted=performance.now();
  const nodes=new Map(),edges=new Map(),docEntities=new Map(),relations=[],extractor=session?'gpt-6-luna-structured-entity-relation-extraction':'offline-titlecase-entity-cooccurrence';
  let extractionTurns=0,extractionUsage=null,extractionWallMs=0,extractionPromptChars=0,extractionSessionId=null;
  if(session){let consumed=0,start=0;
    while(start<documents.length&&extractionTurns<maxExtractionTurns&&consumed<maxExtractionChars){if(signal?.aborted)throw signal.reason??new Error('Baseline run aborted');let end=Math.min(documents.length,start+batchProfile.maxDocuments),batch=documents.slice(start,end),prompt=`Extract only explicitly named entities and explicit binary relations from each passage. Do not infer facts across passages. Preserve each exact passage id. Use concise relation predicates. Passages: ${JSON.stringify(batch.map(d=>({id:d.id,text:d.text})))}`;while(batch.length>1&&prompt.length>batchProfile.maxPromptChars){end=start+Math.max(1,Math.floor(batch.length/2));batch=documents.slice(start,end);prompt=`Extract only explicitly named entities and explicit binary relations from each passage. Do not infer facts across passages. Preserve each exact passage id. Use concise relation predicates. Passages: ${JSON.stringify(batch.map(d=>({id:d.id,text:d.text})))}`;}if(consumed+prompt.length>maxExtractionChars)break;const response=await session.request({prompt,schema:GRAPH_SCHEMA,signal});extractionSessionId=response.sessionId??extractionSessionId;consumed+=prompt.length;extractionPromptChars+=prompt.length;extractionTurns++;extractionUsage=addUsage(extractionUsage,response.usage);extractionWallMs+=response.wallMs??0;
      const byId=new Map(batch.map(d=>[d.id,d]));for(const item of response.output.items??[]){if(!byId.has(item.id))continue;const ents=[...new Set(item.entities.map(x=>x.trim()).filter(Boolean))].slice(0,40);docEntities.set(item.id,ents);for(const relation of item.relations??[])relations.push({...relation,documentId:item.id});}
      start+=batch.length;
    }
  }
  const pattern=/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g;
  const unprocessed=[];
  for(const doc of documents){if(!docEntities.has(doc.id)){if(session){docEntities.set(doc.id,[]);unprocessed.push(doc.id);}else docEntities.set(doc.id,[...new Set((doc.text.match(pattern)??[]).filter(x=>!['The Project Gutenberg','Project Gutenberg','The End'].includes(x)))].slice(0,40));}
    for(const e of docEntities.get(doc.id)){if(!nodes.has(e))nodes.set(e,{id:e,documents:[]});nodes.get(e).documents.push(doc.id);}
    const ents=docEntities.get(doc.id);for(let i=0;i<ents.length;i++)for(let j=i+1;j<ents.length;j++){const key=[ents[i],ents[j]].sort().join('\0');edges.set(key,(edges.get(key)??0)+1);}
  }
  for(const rel of relations){for(const e of [rel.subject,rel.object])if(!nodes.has(e))nodes.set(e,{id:e,documents:[rel.documentId]});const key=[rel.subject,rel.object].sort().join('\0');edges.set(key,(edges.get(key)??0)+2);}
  const communities=louvainCommunities(nodes,edges),byId=new Map(documents.map(d=>[d.id,d]));
  const summaries=communities.map(c=>{c.documentIds=[...new Set(c.entities.flatMap(x=>nodes.get(x)?.documents??[]))];const docs=c.documentIds.map(id=>byId.get(id)).filter(Boolean);const central=[...c.entities].sort((a,b)=>(nodes.get(b).documents.length)-(nodes.get(a).documents.length));const communityRelations=relations.filter(r=>c.entities.includes(r.subject)&&c.entities.includes(r.object)).slice(0,20);return {...c,relations:communityRelations,summary:`Community entities: ${central.slice(0,12).join(', ')}. Explicit relations: ${communityRelations.map(r=>`${r.subject} ${r.predicate} ${r.object}`).join('; ')||'none extracted'}. Representative source passages: ${docs.slice(0,4).map(x=>x.text).join(' ')}`};});
  const built={fingerprint,profile,extractionSessionId,extractionMock:session?.isMock===true||session?.mock===true,nodes:[...nodes.values()],edges:[...edges].map(([key,weight])=>({nodes:key.split('\0'),weight})),communities:summaries,docEntities:Object.fromEntries(docEntities),relations,extractionTurns,extractionUsage,extractionWallMs,extractionPromptChars,unprocessedDocumentIds:unprocessed,extractor,communityMethod:'deterministic weighted Louvain local-modularity optimization',cacheHit:false,buildWallMs:performance.now()-buildStarted};
  await mkdir(indexDir,{recursive:true});const temp=`${cachePath}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(built),{flag:'wx',mode:0o600});await rename(temp,cachePath);
  return {...built,docEntities,observedExtractionUsage:extractionUsage,observedExtractionTurns:extractionTurns,observedExtractionWallMs:extractionWallMs,observedExtractionPromptChars:extractionPromptChars};
}

function graphSearch(query,documents,index,{topK=10}={}) {
  const q=new Set(words(query)), byId=new Map(documents.map(d=>[d.id,d]));
  const communityRank=index.communities.map(c=>{const set=new Set([...words(c.entities.join(' ')),...words(c.summary)]);let score=0;for(const t of q)if(set.has(t))score++;return {...c,score};}).sort((a,b)=>b.score-a.score);
  const selected=new Set(communityRank.slice(0,4).flatMap(c=>c.documentIds));
  const hits=[...selected].map(id=>{const d=byId.get(id);const ent=index.docEntities.get(id)??[];const overlap=ent.reduce((s,e)=>s+([...q].filter(t=>e.toLowerCase().includes(t)).length),0);return {...d,graphScore:overlap+communityRank.find(c=>c.documentIds.includes(id))?.score*0.1??0};}).sort((a,b)=>b.graphScore-a.graphScore).slice(0,topK);
  return {hits,communities:communityRank.slice(0,4),graphStats:{entityCount:index.nodes.length,edgeCount:index.edges.length,relationCount:index.relations.length,communityCount:index.communities.length,extraction:index.extractor,communityMethod:index.communityMethod,summaryMethod:'explicit relation plus representative passages',extractedDocumentCount:index.docEntities.size-index.unprocessedDocumentIds.length,unprocessedDocumentIds:index.unprocessedDocumentIds}};
}

function iterativeAgenticSearch(query,documents,{iterations=3,topK=10}={}) {
  let active=query, hits=[], trace=[];const added=new Set(words(query));
  for(let i=0;i<iterations;i++) {
    const found=bm25Search(active,documents,{topK});trace.push({iteration:i+1,query:active,hitIds:found.map(x=>x.id)});
    const union=new Map([...hits,...found].map(x=>[x.id,x]));hits=[...union.values()].sort((a,b)=>b.lexicalScore-a.lexicalScore).slice(0,topK);
    if(i===iterations-1)break;
    const expansion=[];for(const d of found.slice(0,4))for(const term of words(d.text))if(!added.has(term)&&term.length>4){added.add(term);expansion.push(term);if(expansion.length>=2)break;}if(!expansion.length)break;
    active=`${query} ${expansion.join(' ')}`;
  }
  return {hits,trace,adapterStatus:'offline-deterministic-search-loop'};
}

function sourceEvidence(hit) { return {id:hit.id,type:'source',sourceVersionId:hit.sourceVersionId,regionId:hit.regionId,locator:hit.locator??null,quote:hit.text,semanticStatus:'raw-source-context'}; }
function wholeSourceEvidence(sources,sourceScope,maxChars) {
  const permitted=(sources??[]).filter(s=>!sourceScope||sourceScope.includes(s.id)||sourceScope.includes(s.sourceId)||sourceScope.includes(s.sourceVersionId));
  let used=0, evidence=[];
  for(const s of permitted) {
    const regions=s.regions?.length?s.regions:[{id:'full-text',text:s.content??''}];
    for(const r of regions){if(used>=maxChars)break;const text=String(r.text??'').slice(0,maxChars-used);used+=text.length;evidence.push({id:`full_${idSafe(s.id??s.sourceVersionId)}_${idSafe(r.id)}`,type:'source',sourceVersionId:s.sourceVersionId??s.id,regionId:r.id,locator:r.locator??null,quote:text,semanticStatus:'complete-source-input'});}
  }
  return {permitted,used,evidence};
}

export function procedureContextEvidence(snapshot,sourceScope) {
  const records=snapshot.records??[],byId=new Map(records.map(r=>[r.id,r])),definitions=snapshot.procedures??[],result=[],state=new Map();
  const passageById=new Map();
  for(const source of snapshot.sources??[]){const sourceVersionId=source.sourceVersionId??source.id;if(sourceScope&&!sourceScope.includes(sourceVersionId)&&!sourceScope.includes(source.sourceId)&&!sourceScope.includes(source.id))continue;for(const region of source.regions??[]){
    const id=`passage_${createHash('sha256').update(`${sourceVersionId}:${region.id}`).digest('hex').slice(0,24)}`;
    passageById.set(id,{id,type:'source',sourceVersionId,regionId:region.id,locator:region.locator??null,quote:region.text,semanticStatus:'raw-source-context'});
  }}
  for(const [id,p] of passageById)byId.set(id,p);
  const eligibleFinding=r=>r&&['procedure-finding','contextual-finding'].includes(r.type)&&r.lifecycle==='current'&&r.validation==='model-reviewed'&&r.supportState!=='supported'&&(r.type==='contextual-finding'||definitions.some(p=>p.id===r.procedureId&&String(p.version)===String(r.procedureVersion)&&p.active!==false));
  const addSource=id=>{if(state.get(id)==='visiting')return false;if(state.get(id)==='valid')return true;const record=byId.get(id);if(!record){const source=(snapshot.sources??[]).find(s=>(s.sourceVersionId??s.id)===id);if(source&&(!sourceScope||sourceScope.includes(id)||sourceScope.includes(source.sourceId))){state.set(id,'valid');return true;}return false;}const initial=result.length;state.set(id,'visiting');if(passageById.has(id)){result.push(passageById.get(id));state.set(id,'valid');return true;}if(eligibleFinding(record)){for(const dep of record.dependencies??[])if(!addSource(dep)){result.length=initial;state.delete(id);return false;}result.push({...record,summary:record.summary??record.text});state.set(id,'valid');return true;}
    if(record.sourceVersionId&&record.regionId&&record.quote&&record.lifecycle==='current'&&record.supportState==='supported'&&(!record.validation||['valid','trusted','structurally-valid','source-checked','rule-replayed','semantically-reviewed','model-reviewed','human-approved'].includes(record.validation))&&(!sourceScope||sourceScope.includes(record.sourceVersionId)||sourceScope.includes(record.sourceId))){const q=record.qualifiers??{};result.push({id:record.id,type:'source',sourceVersionId:record.sourceVersionId,regionId:record.regionId,locator:record.locator??null,quote:record.quote,ske:record.ske,attribution:record.attribution??q.attribution??null,time:record.time??q.time??null,modality:record.modality??q.modality??'asserted',polarity:record.polarity??q.polarity??'positive',world:record.world??q.world??null});state.set(id,'valid');return true;}state.delete(id);return false;};
  for(const finding of records.filter(eligibleFinding))addSource(finding.id);
  return result;
}

const ANSWER_SCHEMA={type:'object',additionalProperties:false,required:['answer','claims','citationIds','supportState','residuals'],properties:{answer:{type:'string'},claims:{type:'array',items:{type:'object',additionalProperties:false,required:['text','citationIds'],properties:{text:{type:'string'},citationIds:{type:'array',items:{type:'string'}}}}},citationIds:{type:'array',items:{type:'string'}},supportState:{type:'string',enum:['supported','contested','unresolved']},residuals:{type:'array',items:{type:'string'}}}};
const JUDGE_SCHEMA={type:'object',additionalProperties:false,required:['answerCorrect','residualCorrect','claimReviews','rationale'],properties:{answerCorrect:{type:'boolean'},residualCorrect:{type:'boolean'},claimReviews:{type:'array',items:{type:'object',additionalProperties:false,required:['claimIndex','supportState','rationale'],properties:{claimIndex:{type:'integer'},supportState:{type:'string',enum:['supported','unsupported','ambiguous']},rationale:{type:'string'}}}},rationale:{type:'string'}}};
const GOAL_SCHEMA={type:'object',additionalProperties:false,required:['goal','scope'],properties:{goal:{type:'string'},scope:{type:'object',additionalProperties:false,required:['attribution','time','modality','polarity','world'],properties:{attribution:{type:['string','null']},time:{type:['string','null']},modality:{type:['string','null']},polarity:{type:['string','null']},world:{type:['string','null']}}}}};

async function interpretGoal(question,session,snapshot={},sourceScope,signal) {
  const allowed=(snapshot.records??[]).filter(r=>!sourceScope||sourceScope.includes(r.sourceVersionId)||sourceScope.includes(r.sourceId)||sourceScope.includes(r.id));
  const vocabulary=[...new Set(allowed.flatMap(r=>{try{const x=parseSKE(typeof r.ske==='string'?r.ske:printSKE(r.ske));return x.type==='call'?[x.predicate,...x.args.filter(a=>a.type==='atom').map(a=>a.value)]:[];}catch{return[];}}))].slice(0,160);
  const prompt=`Interpret the user's question as a conservative predicate-first SKE goal. Map it to the authorized vocabulary when possible, preserving predicate direction and argument roles. Do not invent facts. If it cannot be expressed safely, return an empty goal. Use (find (?x) (...)) for requested entities. Preserve requested attribution, time, modality, polarity, and world dimensions in scope. Return a call or find expression as text. Authorized vocabulary from the pinned source scope: ${JSON.stringify(vocabulary)}. Question: ${question}`;
  const {output,...cost}=await session.request({prompt,schema:GOAL_SCHEMA,signal});cost.promptChars=prompt.length;
  return {goal:output.goal?parseSKE(output.goal):null,scope:output.scope,cost};
}

function rulesRelevantToGoal(snapshot,goal) {
  if(!goal)return [];
  const predicatesOf=value=>{try{const ast=typeof value==='string'?parseSKE(value):value,out=[];const walk=x=>{if(!x||typeof x!=='object')return;if(x.type==='call')out.push(x.predicate);for(const v of Object.values(x))if(v&&typeof v==='object')Array.isArray(v)?v.forEach(walk):walk(v);};walk(ast);return out;}catch{return[];}};
  const predicateOf=value=>predicatesOf(value)[0]??null;
  const rules=[...(snapshot.rules??[]),...(snapshot.records??[]).filter(r=>r.type==='rule')]
    .filter(r=>r&&r.lifecycle!=='stale'&&r.lifecycle!=='staged'&&r.lifecycle!=='retracted'&&r.lifecycle!=='superseded'&&r.status!=='stale'&&r.status!=='inactive');
  const needed=new Set(predicatesOf(goal));let changed=true;
  while(changed){changed=false;for(const rule of rules){const conclusion=predicateOf(rule.conclusion);if(!conclusion||!needed.has(conclusion))continue;for(const premise of rule.premises??[]){const p=predicateOf(premise);if(p&&!needed.has(p)){needed.add(p);changed=true;}}}}
  return rules.filter(r=>needed.has(predicateOf(r.conclusion)));
}

async function finalAnswer({question,evidence,session,snapshotId,snapshot,sourceScope,procedureVersions=[],mode='equal-budget',budget={},extraInstructions='',contextEntries,signal}) {
  const limit=mode==='equal-budget'?(budget.contextChars??12000):(budget.contextChars??35000);
  const contexts=contextEntries??evidence.map(e=>({id:e.id,type:e.type,sourceVersionId:e.sourceVersionId,regionId:e.regionId,locator:e.locator,quote:e.quote,ske:e.ske,summary:e.summary,text:e.text,procedureId:e.procedureId,procedureVersion:e.procedureVersion,parameters:e.parameters,outputType:e.outputType,supportState:e.supportState,evidenceIds:e.evidenceIds}));
  const essentials=`Answer the question using only authorized evidence. Cite evidence IDs for each claim. Do not claim support when passages are ambiguous or insufficient; return unresolved residuals. Be concise.\nQuestion: ${question}\n${extraInstructions}\nEvidence JSON:\n`,serialized=JSON.stringify(contexts),prompt=essentials+serialized.slice(0,Math.max(0,limit-essentials.length));
  if(prompt.length>limit||question.length>limit-80)throw new Error('Baseline input budget exhausted before answer generation');
  const turn=await session.request({prompt,schema:ANSWER_SCHEMA,signal});
  const evidenceById=new Map(evidence.map(e=>[e.id,e])),citationIds=[...new Set([...(turn.output.citationIds??[]),...(turn.output.claims??[]).flatMap(c=>c.citationIds??[])])],cited=[],included=new Set();
  const includeEvidence=id=>{if(included.has(id))return;included.add(id);const item=evidenceById.get(id);if(!item)return;cited.push(item);for(const dependency of item.premiseIds??(item.type==='procedure-finding'||item.type==='contextual-finding'?item.dependencies??[]:[]))includeEvidence(dependency);};
  citationIds.forEach(includeEvidence);
  const claims=(turn.output.claims??[]).map(c=>({text:c.text,goal:null,bindings:{},queryScope:null,evidenceIds:(c.citationIds??[]).filter(id=>evidenceById.has(id)),supportState:'unresolved'}));
  const answerPackage={answer:turn.output.answer,claims,interpretation:'Generated by gpt-6-luna from this baseline evidence package; raw source claims remain semantically unverified pending independent semantic review.',supportState:'unresolved',coverage:{evidenceCount:cited.length},procedureVersions,snapshotId:snapshotId??null,residuals:turn.output.residuals??[],modelSupportState:turn.output.supportState};
  const audit=auditEvidence({answerPackage,evidence:cited,snapshot,sourceScope});
  return {answerPackage,evidence:cited,validation:{status:audit.status,errors:audit.errors,modelSupportState:turn.output.supportState},cost:{model:'gpt-6-luna',sessionId:turn.sessionId,usage:turn.usage,modelRequests:1,promptChars:prompt.length,wallMs:turn.wallMs,modelDollarCost:null}};
}

function requestedProcedureInstructions(question,snapshot) {
  const id=question?.procedureId??question?.procedure?.id;if(!id)return '';
  const version=question?.procedureVersion??question?.procedure?.version;
  const definition=question?.procedure??(snapshot.procedures??[]).find(p=>p.id===id&&(!version||String(p.version)===String(version)));
  if(!definition)return `Requested analysis procedure ${id}@${version??'unspecified'}; apply the user parameters ${JSON.stringify(question.parameters??{})} transparently and preserve evidence and uncertainty.`;
  return `Apply the same requested versioned procedure to this question and authorized source evidence. Method definition (public task input): ${JSON.stringify({id:definition.id,version:definition.version,purpose:definition.purpose,applicableInputs:definition.applicableInputs,parameters:definition.parameters,orderedSteps:definition.orderedSteps,evidenceObligations:definition.evidenceObligations,outputSchema:definition.outputSchema})}. User-supplied method parameters: ${JSON.stringify(question.parameters??question.procedure?.parameters??{})}. Follow its criteria, retain counterevidence, and do not claim expert judgment.`;
}

/** One baseline question. In live mode every model call uses the shared Codex Luna session. */
export async function runBaselineRequest({baseline,question,snapshot={},sources=[],sourceScope,session,preprocessingSession,mode='equal-budget',budget={},workspaceDir,signal}={}) {
  if(signal?.aborted)throw signal.reason??new Error('Baseline run aborted');
  if(!BASELINE_IDS.includes(baseline))throw new TypeError(`Unknown baseline ${baseline}`);
  const started=performance.now(),totalPromptCharLimit=budget.totalPromptChars??(mode==='equal-budget'?12000:35000), docs=makeSourceChunks(sources.filter(s=>!sourceScope||[s.id,s.sourceId,s.sourceVersionId].some(x=>sourceScope.includes(x))),{maxChars:budget.chunkChars??1400});
  if(baseline==='skr-direct'||baseline==='skr-full') {
    let goal=question.goal??null, scope=question.scope??null, interpretationCost=null;
    let semantic=null;
    if(baseline==='skr-full'&&session){
      if(!workspaceDir)throw new Error('skr-full semantic resolution requires its Codex session workspace');
      semantic=await resolveSemantics({question:question.text??question,goal,scope,snapshot,sourceScope,session,checkpointDir:join(workspaceDir,'semantic-resolution'),signal,procedures:question.procedures??snapshot.procedures??[]});
      goal=semantic.answerPackage.goal??goal;scope=semantic.answerPackage.scope??scope;
      interpretationCost={usage:semantic.cost?.queryUsage,modelRequests:semantic.cost?.modelRequests??0,promptChars:semantic.cost?.promptChars??0,wallMs:semantic.cost?.wallMs??0};
    } else if(!goal&&session){const interpreted=await interpretGoal(question.text??question,session,snapshot,sourceScope,signal);goal=interpreted.goal;scope=interpreted.scope;interpretationCost=interpreted.cost;}
    // Pass the pinned graph intact; the engine authorizes the complete dependency closure.
    // Filtering only by a finding's own sourceVersionId would drop valid derived records.
    const semanticReceipts=new Map((semantic?.reviewReceipts??[]).map(r=>[r.recordId,r]));
    const trustedSemanticRecords=(semantic?.ephemeralRecords??[]).filter(r=>{const receipt=semanticReceipts.get(r.id);return r.validation==='model-reviewed'&&r.lifecycle==='current'&&r.supportState==='supported'&&receipt?.model==='gpt-6-luna'&&receipt?.decision==='entailed'&&receipt.sourceVersionId===r.sourceVersionId&&receipt.regionId===r.regionId&&receipt.fingerprint===reviewFingerprint(r);});
    let activeRecords=[...(snapshot.records??[]),...trustedSemanticRecords],procedureReviewReceipts=[],procedureEvidence=[],procedureCost=null,runLocalProcedureRecords=[];
    const requestedProcedureId=question.procedureId??question.procedure?.id;
    const requestedProcedureParameters=question.parameters??question.procedureParameters??{};
    if(baseline==='skr-full'&&session&&requestedProcedureId){
      const selected=(snapshot.procedures??[]).find(p=>p.id===requestedProcedureId&&String(p.version)===String(question.procedureVersion??question.procedure?.version??p.version)&&p.active!==false);
      if(!selected)throw new Error(`Selected procedure ${requestedProcedureId}@${question.procedureVersion??question.procedure?.version??''} is not pinned and active`);
      const byRecord=new Map(activeRecords.map(r=>[r.id,r]));
      const closureAuthorized=(record,seen=new Set())=>{if(seen.has(record.id))return false;seen.add(record.id);for(const dep of record.dependencies??[]){const pinned=(snapshot.sources??[]).find(s=>(s.sourceVersionId??s.id)===dep);if(pinned){if(sourceScope&&!sourceScope.includes(dep)&&!sourceScope.includes(pinned.sourceId))return false;continue;}const sourcePassage=(snapshot.sources??[]).some(s=>(!sourceScope||sourceScope.includes(s.sourceVersionId??s.id)||sourceScope.includes(s.sourceId))&&(s.regions??[]).some(region=>`passage_${createHash('sha256').update(`${s.sourceVersionId??s.id}:${region.id}`).digest('hex').slice(0,24)}`===dep));if(sourcePassage)continue;const premise=byRecord.get(dep);if(!premise||premise.lifecycle!=='current'||premise.supportState!=='supported'||(premise.dependencies?.length&&!closureAuthorized(premise,new Set(seen))))return false;}return true;};
      const findings=activeRecords.filter(r=>r.type==='procedure-finding'&&r.procedureId===selected.id&&String(r.procedureVersion)===String(selected.version)&&JSON.stringify(r.parameters??{})===JSON.stringify(requestedProcedureParameters));
      const findingsReusable=findings.every(r=>r.lifecycle==='current'&&r.validation==='model-reviewed'&&closureAuthorized(r));
      const hasCurrent=procedureCoverageComplete(snapshot,{procedureId:selected.id,procedureVersion:selected.version,parameters:requestedProcedureParameters,sourceScope})&&findingsReusable;
      if(!hasCurrent){
        if(!workspaceDir)throw new Error('Selected procedure execution requires its Codex session workspace');
        const procedureLedger={requests:0,promptChars:0,wallMs:0,usage:null};
        const procedureSession={request:async options=>{const result=await session.request(options);procedureLedger.requests++;procedureLedger.promptChars+=String(options?.prompt??'').length;procedureLedger.wallMs+=Number(result?.wallMs)||0;procedureLedger.usage=addUsage(procedureLedger.usage,result?.usage);return result;}};
        const applied=await materializeProcedures({snapshot,procedures:[selected],parameters:{[selected.id]:requestedProcedureParameters},sourceScope,session:procedureSession,checkpointDir:join(workspaceDir,'question-procedure',idSafe(selected.id)),signal});
        const receipts=new Map((applied.reviewReceipts??[]).map(r=>[r.recordId,r]));
        const trusted=(applied.changeSet?.records??[]).filter(r=>{const receipt=receipts.get(r.id);return r.validation==='model-reviewed'&&receipt?.model==='gpt-6-luna'&&receipt.fingerprint===procedureReviewFingerprint(r);});
        activeRecords=[...activeRecords,...trusted];runLocalProcedureRecords=trusted;procedureReviewReceipts=trusted.map(r=>receipts.get(r.id));procedureEvidence=applied.evidence??[];procedureCost={...procedureLedger,model:'gpt-6-luna',findings:trusted.length,coverage:applied.coverage?.length??0};
      }
    }
    const activeSnapshot={...snapshot,records:activeRecords,rules:baseline==='skr-direct'?[]:rulesRelevantToGoal(snapshot,goal)};
    const procedureRuns=[],materializedFindings=baseline==='skr-full'?procedureContextEvidence(activeSnapshot,sourceScope):[];
    const selectedEvidence=[...new Map([...(baseline==='skr-full'?materializedFindings:[])].map(e=>[e.id,e])).values()];
    const resolved=resolveSKR({question:question.text??question,goal,snapshot:activeSnapshot,scope,sourceScope,procedures:question.procedures??snapshot.procedures??[],policy:snapshot.policy??{}});
    const semanticEvidence=semantic?.evidence??[];
    const joinedEvidence=[...new Map([...(resolved.evidence??[]),...selectedEvidence,...semanticEvidence,...procedureEvidence].map(e=>[e.id,e])).values()];
    let final=resolved,answerCost=null;
    if(session){const rendered=await finalAnswer({question:question.text??question,evidence:joinedEvidence,session,snapshotId:activeSnapshot.id,snapshot:activeSnapshot,sourceScope,procedureVersions:resolved.answerPackage.procedureVersions,mode,budget:{...budget,contextChars:Math.max(1,totalPromptCharLimit-(interpretationCost?.promptChars??0))},signal,extraInstructions:[requestedProcedureInstructions(question,snapshot),`The deterministic factual result is ${resolved.answerPackage.supportState}. Preserve it; do not turn unresolved or contested results into supported factual answers. Findings typed procedure-finding or contextual-finding are reviewable assessments, not source facts; you may describe their assessment status but must cite the finding and retain unresolved/contested status. Deterministic result: ${JSON.stringify({answer:resolved.answerPackage.answer,residuals:resolved.answerPackage.residuals})}`].filter(Boolean).join('\n')});
      answerCost=rendered.cost;
      const structuredClaims=resolved.answerPackage.claims??[];
      const semanticClaims=semantic?.answerPackage?.claims??[];
      const renderedClaims=(rendered.answerPackage.claims??[]).map(c=>({...c,goal:null,bindings:{},queryScope:null,evidenceIds:(c.evidenceIds??[]).length?c.evidenceIds:(c.evidenceIds??c.citationIds??[]),supportState:'unresolved',semanticStatus:'model-rendered-unverified'}));
      const claims=[...structuredClaims,...semanticClaims.filter(c=>!structuredClaims.some(x=>JSON.stringify(x.bindings??{})===JSON.stringify(c.bindings??{})&&x.supportState===c.supportState)),...renderedClaims];
      const packageState=resolved.answerPackage.supportState==='contested'||semantic?.answerPackage?.supportState==='contested'?'contested':resolved.answerPackage.supportState==='supported'||semantic?.answerPackage?.supportState==='supported'?'supported':'unresolved';
      final={...resolved,...(semantic?{ephemeralRecords:semantic.ephemeralRecords,reviewReceipts:semantic.reviewReceipts,ledger:semantic.ledger,checkpoint:semantic.checkpoint,semanticValidation:semantic.validation}:{}),evidence:[...new Map([...joinedEvidence,...rendered.evidence].map(e=>[e.id,e])).values()],answerPackage:{...resolved.answerPackage,answer:rendered.answerPackage.answer,claims,supportState:packageState,residuals:[...new Set([...(resolved.answerPackage.residuals??[]),...(semantic?.answerPackage?.residuals??[]),...(rendered.answerPackage.residuals??[])])]},validation:{...resolved.validation,...rendered.validation,auditStatus:rendered.validation.status}};
    }
    const auditSnapshot={...snapshot,records:[...(snapshot.records??[]),...runLocalProcedureRecords]};
    const audit=auditEvidence({answerPackage:final.answerPackage,evidence:session?final.evidence:joinedEvidence,snapshot:auditSnapshot,sourceScope,reviewReceipts:semantic?.reviewReceipts??[],ephemeralRecords:semantic?.ephemeralRecords??[]});
    return {...final,ephemeralRecords:semantic?.ephemeralRecords??[],reviewReceipts:semantic?.reviewReceipts??[],runLocalProcedureRecords,procedureReviewReceipts,evidence:session?final.evidence:joinedEvidence,validation:{...final.validation,auditStatus:audit.status,auditErrors:audit.errors},trace:{baseline,ruleCount:activeSnapshot.rules?.length??0,procedureRuns:procedureRuns.length+runLocalProcedureRecords.length,materializedFindingCount:materializedFindings.filter(e=>e.type==='procedure-finding'||e.type==='contextual-finding').length,semanticIterations:semantic?.ledger?.iterations?.length??0,semanticResolutionStatus:semantic?.checkpoint?.status??null,interpretationCost,procedureCost},cost:{model:'gpt-6-luna',usage:addUsage(interpretationCost?.usage,procedureCost?.usage,answerCost?.usage),requests:(interpretationCost?.modelRequests??Number(Boolean(interpretationCost)))+(procedureCost?.requests??0)+Number(Boolean(answerCost)),promptChars:(interpretationCost?.promptChars??0)+(procedureCost?.promptChars??0)+(answerCost?.promptChars??0),wallMs:performance.now()-started,localSearchCost:null,modelDollarCost:null}};
  }
  let hits=[],trace={},localCost=null;
  if(baseline==='hybrid-rag') {const result=await hybridSearch(question.text??question,docs,{topK:budget.topK??8,rerankK:budget.rerankK??12,indexDir:budget.indexDir??join(process.cwd(),'artifacts','retrieval-indexes')});hits=result.hits;localCost=result.cost;}
  else if(baseline==='agentic-rag') {
    let query=question.text??question, traceTurns=[], aggregate=new Map(), maxTurns=mode==='equal-budget'?3:4,promptCharsUsed=0;
    for(let turn=0;turn<maxTurns;turn++) {
      const found=bm25Search(query,docs,{topK:budget.topK??8});for(const hit of found)aggregate.set(hit.id,hit);
      if(!session||turn===maxTurns-1) {traceTurns.push({turn:turn+1,query,hitIds:found.map(x=>x.id)});break;}
      const prompt=`You are executing agentic retrieval. You just searched the authorized source and obtained the following result passages. Decide the next search query or stop. Choose a new query that addresses remaining evidence gaps; do not answer yet. User question: ${question.text??question}\nCurrent query: ${query}\nCurrent passages: ${JSON.stringify(found.slice(0,5).map(x=>({id:x.id,text:x.text.slice(0,450)})))}`;
      if(promptCharsUsed+prompt.length>totalPromptCharLimit*0.5)break;
      if(signal?.aborted)throw signal.reason??new Error('Baseline run aborted');const decision=await session.request({prompt,schema:{type:'object',additionalProperties:false,required:['nextQuery','stop','reason'],properties:{nextQuery:{type:'string'},stop:{type:'boolean'},reason:{type:'string'}}},signal});promptCharsUsed+=prompt.length;
      traceTurns.push({turn:turn+1,query,hitIds:found.map(x=>x.id),decision:decision.output,sessionId:decision.sessionId,usage:decision.usage});
      if(decision.output.stop||!decision.output.nextQuery)break;query=decision.output.nextQuery;
    }
    hits=[...aggregate.values()].sort((a,b)=>b.lexicalScore-a.lexicalScore).slice(0,budget.topK??8);trace={iterations:traceTurns,adapterStatus:session?'codex-luna-retrieve-decide-search-loop':'offline-deterministic-search-loop',decisionPromptChars:promptCharsUsed};
  }
  else if(baseline==='graphrag') {const index=await graphIndex(docs,{session:preprocessingSession??session,signal,maxExtractionChars:budget.graphExtractionChars??Math.floor(totalPromptCharLimit*0.5),maxExtractionTurns:budget.graphExtractionTurns??1000,indexDir:budget.graphIndexDir??join(process.cwd(),'artifacts','graphrag-indexes')}),retrieved=graphSearch(question.text??question,docs,index,{topK:budget.topK??8});hits=retrieved.hits;trace={graph:retrieved.graphStats,communities:retrieved.communities.map(c=>({id:c.id,entities:c.entities,relations:c.relations,summary:c.summary.slice(0,1000)})),graphExtractionCoverage:docs.length?index.docEntities.size? (index.docEntities.size-index.unprocessedDocumentIds.length)/docs.length:0:1,graphIndexFingerprint:index.fingerprint,graphIndexCacheHit:index.cacheHit,graphIndexProfile:index.profile,unprocessedDocumentIds:index.unprocessedDocumentIds};localCost={graphBuildWallMs:index.buildWallMs,graphIndexCacheHit:index.cacheHit,graphIndexFingerprint:index.fingerprint,graphIndexProfile:index.profile,graphStats:retrieved.graphStats,modelExtractionTurns:index.cacheHit?0:index.extractionTurns,modelExtractionSessionId:index.extractionSessionId,modelUsage:index.extractionUsage,observedModelExtractionTurns:index.observedExtractionTurns,observedModelUsage:index.observedExtractionUsage,historicalModelUsage:index.extractionUsage,modelWallMs:index.extractionWallMs,observedModelWallMs:index.observedExtractionWallMs,modelPromptChars:index.extractionPromptChars,observedModelPromptChars:index.observedExtractionPromptChars};}
  else if(baseline==='full-source-agent') {const full=wholeSourceEvidence(sources,sourceScope,Number.MAX_SAFE_INTEGER);hits=full.evidence.map(e=>({...e,text:e.quote}));trace={sourceCount:full.permitted.length,sourceCharsAvailable:full.used,wholeSourceInput:true};
    if(session){if(!workspaceDir)throw new Error('full-source-agent requires its Codex session workspace');const sourceDir=join(workspaceDir,'sources');await mkdir(sourceDir,{recursive:true});const manifest=[];
      for(const s of full.permitted){const filename=`${idSafe(s.id??s.sourceVersionId)}.txt`,content=s.regions?.length?s.regions.map(r=>`\n[region=${r.id} locator=${JSON.stringify(r.locator??null)}]\n${r.text}`).join('\n'):String(s.content??'');await writeFile(join(sourceDir,filename),content);manifest.push({sourceVersionId:s.sourceVersionId??s.id,path:`sources/${filename}`,characters:content.length});}
      trace.mountedSourceFiles=manifest;trace.sourceCharsMounted=manifest.reduce((n,x)=>n+x.characters,0);
    }}
  if(!hits.length)return {answerPackage:{answer:'Unresolved: no authorized source evidence was retrieved.',claims:[],interpretation:'No evidence retrieved.',supportState:'unresolved',coverage:{documents:docs.length},procedureVersions:[],snapshotId:snapshot.id??null,residuals:['No authorized evidence retrieved.']},evidence:[],coverage:{documents:docs.length},trace:{baseline,...trace},validation:{status:'unresolved'},cost:{wallMs:performance.now()-started,localSearchCost:localCost,modelDollarCost:null}};
  const evidence=hits.map(sourceEvidence);
  if(!session) {
    return {answerPackage:{answer:`Retrieved ${hits.length} passages; a configured answer model is required for a natural-language answer.`,claims:[],interpretation:'Offline retrieval-only mode.',supportState:'unresolved',coverage:{documents:docs.length,retrieved:hits.length},procedureVersions:[],snapshotId:snapshot.id??null,residuals:['Answer generation was not run.']},evidence,coverage:{documents:docs.length,retrieved:hits.length},trace:{baseline,...trace},validation:{status:'retrieval-only'},cost:{wallMs:performance.now()-started,localSearchCost:localCost,modelDollarCost:null}};
  }
  const fullSource=baseline==='full-source-agent';
  const fullEntries=fullSource?(trace.mountedSourceFiles??[]).map(({sourceVersionId,path,characters})=>({type:'complete-authorized-source-file',sourceVersionId,path,characters})):undefined;
  const fullInstructions=fullSource?`Complete authorized source files are mounted in this run workspace. Search/read the complete file using your tools; do not rely on a truncated text prefix. Cite only exact source region IDs present in the file's [region=...] markers. File manifest: ${JSON.stringify(fullEntries)}`:'';
  const priorQueryPromptChars=trace.decisionPromptChars??0,answered=await finalAnswer({question:question.text??question,evidence,session,snapshotId:snapshot.id,snapshot,mode,budget:{...budget,contextChars:Math.max(1024,totalPromptCharLimit-priorQueryPromptChars)},contextEntries:fullEntries,extraInstructions:[requestedProcedureInstructions(question,snapshot),fullInstructions].filter(Boolean).join('\n'),signal});
  const preprocessingMs=Number(localCost?.indexBuildWallMs??localCost?.graphBuildWallMs??0);
  const decisionUsage=trace.iterations?.map(x=>x.usage)??[];
  const queryUsage=addUsage(answered.cost.usage,...decisionUsage),preprocessingUsage=localCost?.modelUsage??{};
  return {...answered,coverage:{documents:docs.length,retrieved:hits.length},trace:{baseline,...trace},cost:{...answered.cost,usage:queryUsage,queryUsage,preprocessingUsage,modelRequests:(answered.cost.modelRequests??1)+(trace.iterations?.length??0),preprocessingRequests:localCost?.modelExtractionTurns??0,queryPromptChars:(answered.cost.promptChars??0)+(trace.decisionPromptChars??0),preprocessingPromptChars:Number(localCost?.modelPromptChars??0),promptChars:(answered.cost.promptChars??0)+(trace.decisionPromptChars??0),localSearchCost:localCost,wallMs:performance.now()-started,preprocessingMs:Number(localCost?.modelWallMs??0),modelDollarCost:null}};
}

export async function createBaselineSession(baseline,{workspaceRoot,sessionOptions={}}={}) {
  const {CodexLunaSession}=await import('../runtime/session.mjs');
  const runId=`${baseline}-${randomUUID()}`,absoluteRoot=resolve(workspaceRoot),workspaceDir=resolve(absoluteRoot,runId),isolation={enabled:true,bwrapPath:'/usr/bin/bwrap',...(sessionOptions.isolation??{}),enabled:true,sessionDir:resolve(absoluteRoot,'sessions',runId)};await mkdir(workspaceDir,{recursive:true});
  return new CodexLunaSession({...sessionOptions,workspaceDir,isolation});
}

/** Execute a paired, live six-baseline comparison. Gold is deliberately not an argument. */
export async function runResearchComparison({question,snapshot,sources,sourceScope,workspaceRoot,sessionOptions={},mode='equal-budget',budget={},baselines=BASELINE_IDS,gold,adjudicationStatus='not-provided',signal,amortizationQueries=1,priceSchedule=null,preprocessingMetadata=null}={}) {
  if(!question||!snapshot||!Array.isArray(sources)||!workspaceRoot)throw new TypeError('question, snapshot, sources, and workspaceRoot are required');
  const rows=[];
  const effectiveBudget={...budget,totalPromptChars:budget.totalPromptChars??(mode==='equal-budget'?35000:Number.MAX_SAFE_INTEGER),totalInputTokens:budget.totalInputTokens??(mode==='equal-budget'?60000:Number.MAX_SAFE_INTEGER),maxToolCalls:budget.maxToolCalls??(mode==='equal-budget'?48:Number.MAX_SAFE_INTEGER)};
  for(const baseline of baselines){if(signal?.aborted)throw signal.reason??new Error('Research comparison aborted');const events=[],preprocessingEvents=[],externalEvent=sessionOptions.onEvent;const makeOptions=target=>({...sessionOptions,onEvent:event=>{target.push(event);externalEvent?.(event);}});const started=performance.now();let preprocessingSession=null,session;
    try{if(baseline==='graphrag')preprocessingSession=await createBaselineSession('graphrag-preprocessing',{workspaceRoot,sessionOptions:makeOptions(preprocessingEvents)});session=await createBaselineSession(baseline,{workspaceRoot,sessionOptions:makeOptions(events)});const result=await runBaselineRequest({baseline,question,snapshot,sources,sourceScope,session,preprocessingSession,mode,budget:effectiveBudget,workspaceDir:session.workspaceDir,signal});const status=await session.status(),cumulativeUsage=status.totalUsage??{},preprocessingStatus=preprocessingSession?await preprocessingSession.status():null,preprocessingUsage=preprocessingStatus?.totalUsage??result.cost?.preprocessingUsage??{};result.cost.sessionId=status.sessionId??result.cost.sessionId??null;result.cost.modelRequests=status.requests??result.cost.modelRequests??0;result.cost.queryUsage=cumulativeUsage;const inputTokens=Number(cumulativeUsage.input_tokens??cumulativeUsage.prompt_tokens??0),cachedInputTokens=Number(cumulativeUsage.cached_input_tokens??0),preprocessingInputTokens=Number(preprocessingUsage.input_tokens??preprocessingUsage.prompt_tokens??0),preprocessingCachedInputTokens=Number(preprocessingUsage.cached_input_tokens??0);const toolCalls=events.filter(e=>e.type==='codex.item.completed'&&/tool|command|shell/i.test(e.itemType??'')).length,preprocessingToolCalls=preprocessingEvents.filter(e=>e.type==='codex.item.completed'&&/tool|command|shell/i.test(e.itemType??'')).length,queryPromptChars=Number(result.cost?.queryPromptChars??result.cost?.promptChars??0),preprocessingPromptChars=Number(result.cost?.preprocessingPromptChars??0);const breaches=[];if(mode==='equal-budget'&&queryPromptChars>effectiveBudget.totalPromptChars)breaches.push('prompt-character-budget-exceeded');if(mode==='equal-budget'&&inputTokens>effectiveBudget.totalInputTokens)breaches.push('measured-model-input-token-budget-exceeded');if(mode==='equal-budget'&&toolCalls>effectiveBudget.maxToolCalls)breaches.push('tool-call-budget-exceeded');result.cost.preprocessingUsage=preprocessingUsage;result.cost.budget={mode,limits:{queryPromptChars:mode==='equal-budget'?effectiveBudget.totalPromptChars:null,inputTokens:mode==='equal-budget'?effectiveBudget.totalInputTokens:null,toolCalls:mode==='equal-budget'?effectiveBudget.maxToolCalls:null},observed:{queryPromptChars,inputTokens,cachedInputTokens,preprocessingPromptChars,preprocessingInputTokens,preprocessingCachedInputTokens,preprocessingToolCalls,toolCalls,requests:status.requests,preprocessingRequests:preprocessingStatus?.requests??result.cost?.preprocessingRequests??0,fullSourceCharsMounted:result.trace?.sourceCharsMounted??null},status:mode==='equal-budget'?(breaches.length?'ineligible':'within-measured-limits'):'measured-quality-first',breaches};rows.push({baseline,result,elapsedMs:performance.now()-started});}
    catch(error){if(signal?.aborted)throw signal.reason??error;rows.push({baseline,error:String(error?.stack??error),elapsedMs:performance.now()-started});}
  }
  if(gold){
    for(const row of rows){
      if(signal?.aborted)throw signal.reason??new Error('Research comparison aborted');if(!row.result)continue;
      try{
        const judge=await createBaselineSession(`judge-${row.baseline}`,{workspaceRoot,sessionOptions}),answer=row.result.answerPackage;
        const evidence=row.result.evidence.map(e=>({id:e.id,type:e.type,sourceVersionId:e.sourceVersionId,regionId:e.regionId,locator:e.locator,quote:e.quote,ske:e.ske}));
        const prompt=`Independently evaluate this baseline response using the source evidence. This is judge-only material and must not be passed to any answer generator. Compare the answer to the reference answer for semantic correctness; do not require wording equality. For every listed answer claim, decide if its cited available evidence entails the claim. Mark residualCorrect true if the response properly communicates uncertainty for a question whose reference says unresolved/contested, or otherwise accurately handles the reference. The automatic reference may itself be pending human review. Return model judgment, not expert or human approval.\nQuestion: ${question.text??question}\nReference answer/state: ${JSON.stringify(gold)}\nCandidate answer package: ${JSON.stringify(answer)}\nCandidate evidence: ${JSON.stringify(evidence)}`;
        const judged=await judge.request({prompt,schema:JUDGE_SCHEMA,signal});
        const audit=auditEvidence({answerPackage:answer,evidence:row.result.evidence,snapshot,sourceScope,reviewReceipts:row.result.reviewReceipts??[],ephemeralRecords:row.result.ephemeralRecords??[]}),claimReviews=judged.output.claimReviews??[];
        const goldEvidence=Array.isArray(gold.evidence)?gold.evidence:Array.isArray(gold.evidenceSpans)?gold.evidenceSpans:[],mapped=mapGoldEvidenceSpans(goldEvidence,snapshot,sourceScope),candidateSpans=row.result.evidence.map(e=>normalizeEvidenceSpan(e,snapshot,sourceScope?.[0])).filter(Boolean);
        const goldUnion=unionEvidenceIntervals(mapped.spans),candidateUnion=unionEvidenceIntervals(candidateSpans),intersectChars=evidenceIntersectionLength(goldUnion,candidateUnion),goldChars=goldUnion.reduce((n,x)=>n+x.end-x.start,0),retrievedChars=candidateUnion.reduce((n,x)=>n+x.end-x.start,0),goldMappingStatus=goldEvidence.length===0?'no-gold-evidence':mapped.complete?'complete':mapped.spans.length?'partial':'unmapped';
        row.adjudication={status:'model-judged-pending-human-review',model:'gpt-6-luna',sessionId:judged.sessionId,usage:judged.usage,wallMs:judged.wallMs,answerCorrect:judged.output.answerCorrect?1:0,residualCorrect:judged.output.residualCorrect?1:0,supportedClaimFraction:claimReviews.length?claimReviews.filter(x=>x.supportState==='supported').length/claimReviews.length:null,evidencePrecision:goldMappingStatus==='complete'?(retrievedChars?Math.min(1,intersectChars/retrievedChars):0):null,evidenceRecall:goldMappingStatus==='complete'?(goldChars?Math.min(1,intersectChars/goldChars):null):null,evidenceCoordinateStatus:goldMappingStatus,goldEvidenceSpanCount:goldEvidence.length,mappedGoldEvidenceSpanCount:mapped.spans.length,retrievedEvidenceSpanCount:candidateSpans.length,claimReviews,sourceIntegrityAudit:audit.status,sourceIntegrityErrors:audit.errors,rationale:judged.output.rationale};
        row.result.cost.judge={sessionId:judged.sessionId,usage:judged.usage,wallMs:judged.wallMs,model:'gpt-6-luna'};
      }catch(error){if(signal?.aborted)throw signal.reason??error;row.adjudication={status:'judge-error',error:String(error)};}
    }
  }
  const usageTotals=usageRows=>usageRows.reduce((sum,u)=>{sum.inputTokens+=Number(u.input_tokens??u.prompt_tokens??0);sum.cachedInputTokens+=Number(u.cached_input_tokens??0);sum.outputTokens+=Number(u.output_tokens??u.completion_tokens??0);sum.reasoningOutputTokens+=Number(u.reasoning_output_tokens??0);return sum;},{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0});
  for(const row of rows){if(!row.result)continue;const c=row.result.cost??{},local=c.localSearchCost??{},queryUsage=c.queryUsage??c.usage??null,observedPrep=local.observedModelUsage??(row.baseline==='graphrag'&&!local.graphIndexCacheHit?local.modelUsage:null),historicalPrep=local.historicalModelUsage??(local.graphIndexCacheHit?local.modelUsage:null)??(row.baseline==='skr-full'||row.baseline==='skr-direct'?preprocessingMetadata?.usage?.totalUsage??preprocessingMetadata?.ingestion?.usage?.totalUsage??null:null),judgeUsage=c.judge?.usage??null,sessions=[];if(queryUsage)sessions.push({stage:'answer-and-query-planning',sessionId:c.sessionId??null,usage:queryUsage,requests:c.modelRequests??null});if(observedPrep)sessions.push({stage:'graph-preprocessing',sessionId:local.modelExtractionSessionId??null,usage:observedPrep,requests:local.observedModelExtractionTurns??local.modelExtractionTurns??null});if(historicalPrep&&row.baseline.startsWith('skr-'))sessions.push({stage:'pinned-ingestion-preprocessing',sessionId:preprocessingMetadata?.ingestion?.validation?.sessionId??null,usage:historicalPrep,requests:preprocessingMetadata?.ingestion?.validation?.calls??null,historical:true});if(judgeUsage)sessions.push({stage:'independent-judge',sessionId:c.judge.sessionId??row.adjudication?.sessionId??null,usage:judgeUsage,requests:1});c.sessions=sessions;c.usageTotal=usageTotals(sessions.map(s=>s.usage));c.historicalPreprocessingUsage=historicalPrep??null;c.preprocessingAccounting=row.baseline.startsWith('skr-')?(historicalPrep?'measured-from-pinned-ingestion-report':'not-recorded-in-pinned-ingestion-metadata'):local.graphIndexCacheHit?'cached-index-original-build-cost-retained':'measured-current-run';c.preprocessingRequests=row.baseline.startsWith('skr-')?preprocessingMetadata?.ingestion?.validation?.calls??null:local.modelExtractionTurns??null;c.preprocessingSessionId=row.baseline.startsWith('skr-')?preprocessingMetadata?.ingestion?.validation?.sessionId??null:local.modelExtractionSessionId??null;c.priceSchedule=priceSchedule?{model:priceSchedule.model,currency:priceSchedule.currency,effectiveDate:priceSchedule.effectiveDate}:null;c.queryPrice=priceUsage(queryUsage,priceSchedule);c.observedPreprocessingPrice=observedPrep?priceUsage(observedPrep,priceSchedule):row.baseline.startsWith('skr-')||row.baseline!=='graphrag'?{total:0,currency:priceSchedule?.currency??null,notApplicable:true}:null;c.historicalPreprocessingPrice=historicalPrep?priceUsage(historicalPrep,priceSchedule):null;c.amortizedPreprocessingPrice=c.historicalPreprocessingPrice?{...c.historicalPreprocessingPrice,total:c.historicalPreprocessingPrice.total/Math.max(1,Number(amortizationQueries)||1)}:null;c.judgePrice=priceUsage(judgeUsage,priceSchedule);c.totalObservedPrice=c.queryPrice&&c.judgePrice&&(c.observedPreprocessingPrice||c.historicalPreprocessingPrice)?{currency:priceSchedule?.currency??null,total:c.queryPrice.total+c.judgePrice.total+(c.observedPreprocessingPrice?.total??0)}:null;}
  const costAmortization=rows.map(row=>{const c=row.result?.cost??{};const pre=c.historicalPreprocessingUsage??c.preprocessingUsage??c.localSearchCost?.historicalModelUsage??{};const prepInput=Number(pre.input_tokens??pre.prompt_tokens??0);return {baseline:row.baseline,amortizationQueryCount:Math.max(1,Number(amortizationQueries)||1),query:{promptChars:Number(c.queryPromptChars??c.promptChars??0),inputTokens:c.budget?.observed?.inputTokens??null,wallMs:c.wallMs==null?null:Math.max(0,c.wallMs-Number(c.observedPreprocessingMs??0)),requests:c.requests??c.modelRequests??null},preprocessing:{status:c.preprocessingAccounting??'not-recorded',promptChars:Number(c.localSearchCost?.modelPromptChars??c.preprocessingPromptChars??0),inputTokens:pre?prepInput:null,wallMs:c.localSearchCost?.modelWallMs??c.preprocessingMs??c.localSearchCost?.indexBuildWallMs??c.localSearchCost?.graphBuildWallMs??null,requests:c.preprocessingRequests??c.localSearchCost?.modelExtractionTurns??null},amortizedPreprocessing:{promptChars:Number(c.localSearchCost?.modelPromptChars??c.preprocessingPromptChars??0)/Math.max(1,Number(amortizationQueries)||1),inputTokens:pre?prepInput/Math.max(1,Number(amortizationQueries)||1):null,wallMs:c.localSearchCost?.modelWallMs??c.preprocessingMs?Number(c.localSearchCost?.modelWallMs??c.preprocessingMs)/Math.max(1,Number(amortizationQueries)||1):null}};});
  return {experiment:'paired-live-six-baseline',model:'gpt-6-luna',mode,budget:effectiveBudget,amortizationQueries:Math.max(1,Number(amortizationQueries)||1),costAmortization,question,snapshotId:snapshot.id,sourceScope,adjudicationStatus:gold?`${adjudicationStatus}; model-judged-pending-human-review`:'not-provided',rows,interpretation:'Paired live model-run artifact. Model judgments are separately labeled and do not claim expert adjudication. Preprocessing and per-query costs are reported separately and preprocessing amortization uses the declared query-count assumption. Token/tool limits are checked from observed session usage; a system that exceeds them is marked ineligible.'};
}

/** Offline retrieval-only pass over the complete pinned public-book corpus. */
export async function runBookOfflineEvaluation({fixturePath='fixtures/book-questions-v1.json',manifestPath='corpora/books/manifest.json',baselines=BASELINE_IDS,mode='equal-budget',budget={}}={}) {
  const {readFile}=await import('node:fs/promises');const manifest=JSON.parse(await readFile(manifestPath,'utf8')),fixture=JSON.parse(await readFile(fixturePath,'utf8'));
  const root=process.cwd(),books=[];
  for(const item of manifest.books){const bytes=await readFile(join(root,item.file??item.path)),full=bytes.toString('utf8'),startToken='*** START OF THE PROJECT GUTENBERG EBOOK',endToken='*** END OF THE PROJECT GUTENBERG EBOOK',mark=full.indexOf(startToken),bodyStart=full.indexOf('***',mark+startToken.length),bodyEnd=full.indexOf(endToken,bodyStart);if(mark<0||bodyStart<0||bodyEnd<0)throw new Error(`Complete work boundaries unavailable for ${item.id}`);const workStart=bodyStart+3,body=full.slice(workStart,bodyEnd),sha256=createHash('sha256').update(bytes).digest('hex');if(item.sha256&&sha256!==item.sha256)throw new Error(`Pinned source digest mismatch for ${item.id}`);books.push({id:item.id,sourceId:item.id,sourceVersionId:`${item.id}-${sha256.slice(0,16)}`,digest:sha256,full,workStart,body,regions:[{id:`${item.id}-work`,text:body,locator:{sourceStartChar:workStart,sourceEndChar:bodyEnd}}]});}
  const rows=[];
  const questions=fixture.questions??fixture.cases??[];
  for(const item of questions){const sourceId=item.sourceId??item.source?.bookId,source=books.find(x=>x.id===sourceId);if(!source)throw new Error(`Question ${item.id} refers to unknown source ${sourceId}`);const question=item.question??item.text;if(!question)throw new Error(`Question ${item.id} has no question text`);let goldSpans=item.evidence??[];
    if(!goldSpans.length&&item.gold?.evidence?.quote){const quote=item.gold.evidence.quote,at=source.body.indexOf(quote);if(at>=0)goldSpans=[{startChar:source.workStart+at,endChar:source.workStart+at+quote.length,quote}];}
    for(const span of goldSpans){if(!Number.isFinite(span.startChar)||!Number.isFinite(span.endChar)){const quote=span.quote??'',at=quote?source.body.indexOf(quote):-1;if(at>=0){span.startChar=source.workStart+at;span.endChar=span.startChar+quote.length;}}}
    for(const baseline of baselines){const runSource={...source,regions:[{...source.regions[0],id:`${source.id}-work`,locator:{...source.regions[0].locator}}]},result=await runBaselineRequest({baseline,question:{text:question},snapshot:{id:`books-${manifest.version}`,records:[],rules:[],procedures:[],sources:[runSource]},sources:[runSource],sourceScope:[source.sourceVersionId],mode,budget});const ranges=result.evidence.map(e=>({start:e.locator?.startChar??NaN,end:e.locator?.endChar??NaN})).filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end));const intersection=(a,b)=>Math.max(0,Math.min(a.end,b.end)-Math.max(a.start,b.start));const validGold=goldSpans.filter(g=>Number.isFinite(g.startChar)&&Number.isFinite(g.endChar)),relevantChars=validGold.reduce((n,g)=>n+Math.max(0,g.endChar-g.startChar),0),retrievedChars=ranges.reduce((n,r)=>n+r.end-r.start,0),overlapChars=validGold.reduce((n,g)=>n+ranges.reduce((m,r)=>m+intersection({start:g.startChar,end:g.endChar},r),0),0),spanRecall=validGold.length?validGold.filter(g=>ranges.some(r=>r.start<=g.startChar&&r.end>=g.endChar)).length/validGold.length:null;rows.push({caseId:item.id,sourceId,baseline,result,expected:item.expected??item.gold?.answer??null,adjudication:item.adjudication?.status??item.gold?.adjudication?.status??'pending-human-review',metrics:{evidenceCharacterPrecision:retrievedChars?Math.min(1,overlapChars/retrievedChars):0,evidenceCharacterRecall:relevantChars?Math.min(1,overlapChars/relevantChars):null,evidenceSpanRecall:spanRecall,answerAccuracy:null,claimSupportRate:null}});}}
  return {experiment:'public-books-offline-retrieval',manifestVersion:manifest.version,questionSetId:fixture.id,caseCount:questions.length,rows,interpretation:'Offline retrieval and source-location smoke only. Proposed answers/evidence are pending human review; no expert accuracy is claimed.'};
}
