import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseSKE, printSKE } from '../engine/index.mjs';
import { chunkSourceRegions } from '../source-readers.mjs';
import { makeContextReviewReceipt, makeProcedureReviewReceipt, makeReviewReceipt } from './receipts.mjs';

const LUNA = 'gpt-6-luna';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const stableJson=value=>Array.isArray(value)?`[${value.map(stableJson).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`:JSON.stringify(value);
const procedureCoverageId=(procedure,sourceVersionId,regionKey,parameterFingerprint)=>`proc_cov_${hash(`${procedure.id}@${procedure.version}:${parameterFingerprint}:${sourceVersionId}:${regionKey}`).slice(0,24)}`;
const addUsage = (a = {}, b = {}) => Object.fromEntries(new Set([...Object.keys(a), ...Object.keys(b)]).values().map(k => [k, (Number(a[k]) || 0) + (Number(b[k]) || 0)]));
const safeToken = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
const snapshotRecords = snapshot => snapshot.records ?? [];
const sourceVersion = source => source.sourceVersionId ?? source.id;
const scoped = (source, scope) => !scope || scope.includes(source.id) || scope.includes(source.sourceVersionId) || scope.includes(source.sourceId);
const supportedModalities = new Set(['asserted', 'possible', 'necessary', 'believed', 'reported', 'conditional', 'counterfactual', 'uncertain', 'ordered', 'order', 'permitted', 'obligatory', 'prohibited']);
const polarities = new Set(['positive', 'negative', 'unknown']);

const ASSERTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['assertions'], properties: {
    assertions: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['ske','regionId','quote','qualifiers','entities'], properties: {
      ske: { type: 'string', minLength: 3 }, regionId: { type: 'string' }, quote: { type: 'string', minLength: 1 },
      qualifiers: { type: 'object', additionalProperties: false, required: ['attribution','time','modality','polarity','world'], properties: { attribution: { type: ['string','null'] }, time: { type: ['string','null'] }, modality: { type: ['string','null'] }, polarity: { type: ['string','null'] }, world: { type: ['string','null'] } } },
      entities: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['surface','canonicalName','kind'], properties: { surface: { type: 'string', minLength: 1 }, canonicalName: { type: ['string','null'] }, kind: { type: ['string','null'] } } } }
    } } }
  }
};
const REVIEW_SCHEMA = candidateIds => ({
  type: 'object', additionalProperties: false, required: ['reviews'], properties: {
    reviews: { type: 'array', maxItems: candidateIds.length, items: { type: 'object', additionalProperties: false, required: ['candidateId','decision','rationale','qualifiers','entityDecisions','counterevidence'], properties: {
      candidateId: { type: 'string', enum: candidateIds }, decision: { type: 'string', enum: ['entailed','not-entailed','uncertain'] }, rationale: { type: 'string' },
      qualifiers: { type: 'object', additionalProperties: false, required: ['attribution','time','modality','polarity','world'], properties: { attribution: { type: ['string','null'] }, time: { type: ['string','null'] }, modality: { type: ['string','null'] }, polarity: { type: ['string','null'] }, world: { type: ['string','null'] } } },
      entityDecisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['surface','decision','entityId','canonicalName','rationale'], properties: { surface: { type: 'string' }, decision: { type: 'string', enum: ['new','same-as','ambiguous'] }, entityId: { type: ['string','null'] }, canonicalName: { type: ['string','null'] }, rationale: { type: ['string','null'] } } } },
      counterevidence: { type: 'array', items: { type: 'string', enum: candidateIds } }
    } } }
  }
});

function outputObject(output, label) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error(`${label} returned a non-object JSON value`);
  return output;
}
function regionMap(snapshot, scope) {
  const sources = new Map(), regions = new Map();
  for (const source of snapshot.sources ?? []) if (scoped(source, scope)) {
    sources.set(sourceVersion(source), source);
    for (const region of source.regions ?? []) regions.set(`${sourceVersion(source)}:${region.id}`, { source, region });
  }
  return { sources, regions };
}
function adjacentRegionContext(snapshot,candidate,radius=1) {
  const source=(snapshot.sources??[]).find(s=>sourceVersion(s)===candidate.sourceVersionId);
  if(!source)return [];
  const regions=source.regions??[],index=regions.findIndex(r=>r.id===candidate.regionId);
  if(index<0)return [];
  return regions.slice(Math.max(0,index-radius),Math.min(regions.length,index+radius+1)).map((r,i)=>({sourceVersionId:sourceVersion(source),regionId:r.id,role:r.id===candidate.regionId?'cited-claim-region':'adjacent-context-only',locator:r.locator??null,sourceSegment:r.sourceSegment??null,text:r.text}));
}
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temp, file);
}
/** Explicitly re-open one extraction chunk in a pinned checkpoint after inspecting its ledger. */
export async function retryIngestionChunk({ checkpointDir, sourceVersionId, chunkId, expectedFingerprint } = {}) {
  if(!checkpointDir||!sourceVersionId||!/^chunk_[1-9]\d*$/.test(chunkId??'')) throw new TypeError('checkpointDir, sourceVersionId and chunkId are required');
  const file=path.join(checkpointDir,'ingestion-checkpoint.json'), checkpoint=JSON.parse(await readFile(file,'utf8'));
  if(!expectedFingerprint||checkpoint.fingerprint!==expectedFingerprint) throw new Error('Retry requires the exact pinned ingestion checkpoint fingerprint');
  const key=`${sourceVersionId}:${chunkId}`, prior=checkpoint.chunks?.[key];
  if(!prior) throw new Error('Chunk is not present in this checkpoint');
  checkpoint.chunks[key]={status:'retry-requested',previousStatus:prior.status,retryRequestedAt:new Date().toISOString()};
  checkpoint.context=undefined; checkpoint.status='partial'; checkpoint.updatedAt=new Date().toISOString();
  await atomicJson(file,checkpoint);
  return {sourceVersionId,chunkId,fingerprint:checkpoint.fingerprint,status:'retry-requested'};
}
function checkpointFingerprint(snapshot, sourceScope, procedures, limits = {}) {
  return hash({ snapshotId: snapshot.id, sourceScope: [...sourceScope].sort(), policy: snapshot.policy ?? {},
    sources: (snapshot.sources ?? []).filter(s => scoped(s, sourceScope)).map(s => [sourceVersion(s), s.digest, s.readerProfile]),
    procedures: (procedures ?? []).map(p => [p.id, p.version]), limits });
}
function exactRegionCheck(candidate, rmap) {
  const pair = rmap.regions.get(`${candidate.sourceVersionId}:${candidate.regionId}`);
  return pair && typeof candidate.quote === 'string' && candidate.quote.trim().length > 0 && pair.region.text.includes(candidate.quote)
    ? pair : null;
}
function normalizeQualifiers(input = {}) {
  const modality = input.modality == null ? 'asserted' : supportedModalities.has(input.modality) ? input.modality : 'uncertain';
  const polarity = input.polarity == null ? 'positive' : polarities.has(input.polarity) ? input.polarity : 'unknown';
  return { attribution: input.attribution ?? null, time: input.time ?? null, modality, polarity, world: input.world ?? null };
}
const entitySlug = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
function bindEntityIds(text, mentions) {
  const idByTerm = new Map();
  for (const m of mentions) if (m.entityId && m.decision !== 'ambiguous') {
    idByTerm.set(entitySlug(m.surface), m.entityId);
    if (m.canonicalName) idByTerm.set(entitySlug(m.canonicalName), m.entityId);
  }
  const rewrite = node => {
    if (node?.type === 'call') return { ...node, args: node.args.map(arg => {
      if (arg.type === 'atom') {
        const raw = entitySlug(arg.value), suffix = entitySlug(arg.value.split(':').at(-1));
        const entityId = idByTerm.get(raw) ?? idByTerm.get(suffix);
        return entityId ? { type: 'atom', value: entityId } : arg;
      }
      return rewrite(arg);
    }) };
    if (node?.type === 'and') return { ...node, terms: node.terms.map(rewrite) };
    return node;
  };
  return printSKE(rewrite(parseSKE(text)));
}
function knownEntities(snapshot) {
  const map = new Map();
  for (const record of snapshotRecords(snapshot)) for (const entity of record.entityMentions ?? []) {
    if (entity.entityId && entity.surface) map.set(entity.entityId, { id: entity.entityId, canonicalName: entity.canonicalName ?? entity.surface, aliases: [entity.surface] });
  }
  for (const e of snapshot.entities ?? []) if (e.id) map.set(e.id, e);
  return map;
}
const candidateEntityId = (candidate, surface) => {
  let proposition; try { proposition=printSKE(parseSKE(candidate.ske)); } catch { proposition=String(candidate.ske); }
  return `entity_${hash(`${candidate.sourceVersionId}:${candidate.regionId}:${proposition}:${entitySlug(surface)}`).slice(0,24)}`;
};

/** Separately review proposed source interpretations and bind accepted decisions to exact evidence. */
export async function reviewAssertions({ candidates, snapshot, sourceScope, session, signal, onEvent } = {}) {
  if (!Array.isArray(candidates) || !snapshot?.id || !session?.request) throw new TypeError('candidates, pinned snapshot, and Luna session are required');
  const rmap = regionMap(snapshot, sourceScope), eligible = [], malformed = [], rejected = [];
  for (const candidate of candidates) {
    const pair = rmap.regions.get(`${candidate.sourceVersionId}:${candidate.regionId}`);
    if (!pair) { rejected.push({ candidateId: candidate.candidateId, reason: 'source region did not reopen in scope' }); continue; }
    const quoteValid=typeof candidate.quote==='string'&&candidate.quote.trim().length>0&&pair.region.text.includes(candidate.quote);
    try {
      const ast = parseSKE(candidate.ske);
      if (ast.type !== 'call' || JSON.stringify(ast).includes('"type":"variable"')) throw new Error('assertion must be a ground predicate call');
      if(quoteValid) eligible.push({ ...candidate, ske: printSKE(ast) });
      else malformed.push({ ...candidate, regionText:pair.region.text, parseError:null, quoteError:'quoted text did not reopen' });
    } catch (error) { malformed.push({ ...candidate, regionText:pair.region.text, parseError: error.message, quoteError:quoteValid?null:'quoted text did not reopen' }); }
  }
  let repairCalls = 0, usage = {}, wallMs = 0;
  if (malformed.length) {
    const ids = malformed.map(c => c.candidateId);
    const schema = { type:'object', additionalProperties:false, required:['repairs'], properties:{ repairs:{ type:'array', minItems:ids.length, maxItems:ids.length, items:{ type:'object', additionalProperties:false, required:['candidateId','ske','quote'], properties:{ candidateId:{type:'string',enum:ids}, ske:{type:'string',minLength:3}, quote:{type:'string',minLength:1} } } } } };
    const repaired = await session.request({ signal, schema, prompt:`Repair only transport syntax and the quoted source substring for these proposals. Preserve the proposition meaning and do not add facts. Quote must be copied verbatim from that candidate's exact reopened source region. Required SKE grammar: parenthesized whitespace-separated tokens, e.g. (located_in entity_a place_b), (ordered_to king doctors). Never use function-call syntax or commas. Return one repair per candidate ID.
${JSON.stringify(malformed.map(c=>({candidateId:c.candidateId,ske:c.ske,parseError:c.parseError,quoteError:c.quoteError,quote:c.quote,regionText:c.regionText,entities:c.entities})))}` });
    usage=addUsage(usage,repaired.usage);wallMs+=Number(repaired.wallMs)||0;repairCalls++;
    const repairs = new Map((outputObject(repaired.output,'SKE/quote repair').repairs ?? []).map(x=>[x.candidateId,x]));
    for (const candidate of malformed) {
      try { const repair=repairs.get(candidate.candidateId); if(!repair||!rmap.regions.get(`${candidate.sourceVersionId}:${candidate.regionId}`).region.text.includes(repair.quote))throw new Error('repaired quote does not reopen'); const ast=parseSKE(repair.ske); if(ast.type!=='call'||JSON.stringify(ast).includes('"type":"variable"')) throw new Error('repaired expression is not a ground predicate call'); eligible.push({...candidate,quote:repair.quote,ske:printSKE(ast)}); }
      catch(error) { rejected.push({candidateId:candidate.candidateId,reason:`syntax repair failed: ${error.message}`}); }
    }
  }
  if (!eligible.length) return { records: [], receipts: [], rejected, calls:repairCalls };
  const known = [...knownEntities(snapshot).values()];
  const payload = eligible.map(c => ({ candidateId: c.candidateId, ske: c.ske, quote: c.quote, sourceVersionId: c.sourceVersionId, regionId: c.regionId,
    qualifiers: c.qualifiers ?? {}, entities: (c.entities ?? []).map(e=>({...e,provisionalEntityId:candidateEntityId(c,e.surface)})), regionText: rmap.regions.get(`${c.sourceVersionId}:${c.regionId}`).region.text,
    adjacentRegions:adjacentRegionContext(snapshot,c,1) }));
  const result = await session.request({ signal, schema: REVIEW_SCHEMA(eligible.map(x => x.candidateId)), prompt: `You are the separate semantic reviewer for a source-grounded knowledge system. The cited region is the only region from which the candidate's quoted assertion may be supported; adjacent regions are context only and cannot be silently concatenated into the citation. Use adjacent context to resolve local pronouns, sentence fragments, attribution, modality, world scope, or visible counterevidence. If a sentence requires text from another region for its missing premise, do not promote the assertion unless the exact cited quote itself entails it. Preserve the proposed roles, polarity, time, modality, and attribution; do not infer omitted roles or upgrade possibility to actuality. Use uncertain when identity or a material qualifier remains ambiguous and not-entailed for a mismatch. Use the world qualifier to distinguish fictional narrative events from real-world claims when the surrounding source framing supports that distinction; do not assume fiction solely from a title or from Project Gutenberg markers. Report every counterexample or conflicting assertion visible in the supplied context. For entity decisions, reuse an existing or batch provisional entity when identity is clear from the supplied context, choose new when the mention is clearly distinct, and use ambiguous when identity is unclear. Return one review per candidate.\n\nKnown entities and batch provisional IDs (reuse a provisional ID across candidates only when the source establishes they are the same entity; keep same-name entities distinct otherwise):\n${JSON.stringify({known,proposed:payload.map(c=>({candidateId:c.candidateId,entities:c.entities}))})}\n\nCandidates, exact cited text, and neighboring context:\n${JSON.stringify(payload)}` });
  usage=addUsage(usage,result.usage);wallMs+=Number(result.wallMs)||0;
  const output = outputObject(result.output, 'Assertion review');
  const byCandidate = new Map(eligible.map(x => [x.candidateId, x]));
  const reviews = new Map();
  for (const review of output.reviews ?? []) {
    if (!byCandidate.has(review.candidateId) || reviews.has(review.candidateId)) continue;
    reviews.set(review.candidateId, review);
  }
  const records = [], receipts = [], catalog = knownEntities(snapshot), candidateRecordIds = new Map();
  for (const candidate of eligible) for (const decision of reviews.get(candidate.candidateId)?.entityDecisions ?? []) {
    if (decision.decision !== 'new') continue;
    const surface=String(decision.surface??'').trim(); if(!surface) continue;
    const entityId=candidateEntityId(candidate,surface);
    catalog.set(entityId,{id:entityId,canonicalName:String(decision.canonicalName??surface).trim(),aliases:[surface],kind:decision.kind??null});
  }
  for (const candidate of eligible) {
    const review = reviews.get(candidate.candidateId);
    if (!review || review.decision !== 'entailed') { rejected.push({ candidateId: candidate.candidateId, reason: review?.decision ?? 'review omitted' }); continue; }
    const pair = exactRegionCheck(candidate, rmap);
    const mergedQualifiers = { ...(candidate.qualifiers ?? {}) };
    for (const key of ['attribution','time','modality','polarity','world']) if (review.qualifiers?.[key] != null) mergedQualifiers[key] = review.qualifiers[key];
    const qualifiers = normalizeQualifiers(mergedQualifiers);
    const entityDecisions = [];
    for (const decision of review.entityDecisions ?? []) {
      const surface = String(decision.surface ?? '').trim(); if (!surface) continue;
      if (decision.decision === 'same-as' && decision.entityId && catalog.has(decision.entityId)) {
        const knownEntity = catalog.get(decision.entityId);
        entityDecisions.push({ surface, canonicalName: knownEntity.canonicalName ?? knownEntity.name ?? surface, entityId: decision.entityId, decision: 'same-as', reversible: true });
      } else if (decision.decision === 'new') {
        const canonicalName = String(decision.canonicalName ?? surface).trim();
        const entityId = candidateEntityId(candidate,surface);
        const definition = { id: entityId, canonicalName, aliases: [surface], kind: decision.kind ?? null };
        catalog.set(entityId, definition);
        entityDecisions.push({ surface, canonicalName, entityId, decision: 'new', reversible: true });
      } else entityDecisions.push({ surface, canonicalName: decision.canonicalName ?? surface, decision: 'ambiguous', reversible: true, rationale: decision.rationale ?? null });
    }
    const canonicalSke = bindEntityIds(candidate.ske, entityDecisions);
    const record = {
      id: `assert_${hash(`${candidate.sourceVersionId}:${candidate.regionId}:${candidate.quote}:${canonicalSke}:${JSON.stringify(qualifiers)}`).slice(0, 28)}`,
      type: 'source-assertion', ske: canonicalSke, sourceVersionId: candidate.sourceVersionId, sourceId: pair.source.sourceId,
      regionId: candidate.regionId, quote: candidate.quote, locator: pair.region.locator, sourceSnapshotId: snapshot.id,
      qualifiers, attribution: qualifiers.attribution, time: qualifiers.time, modality: qualifiers.modality, polarity: qualifiers.polarity, world: qualifiers.world,
      entityMentions: entityDecisions, counterevidence: [],
      lifecycle: 'current', supportState: 'supported', validation: 'model-reviewed', origin: 'source-assertion',
      review: { model: LUNA, sessionId: result.sessionId, reviewedAt: new Date().toISOString(), decision: 'entailed', rationale: String(review.rationale ?? ''), method: 'separate-Luna-review-turn' }
    };
    record.review.receiptFingerprint = hash({ sourceVersionId: record.sourceVersionId, sourceId: record.sourceId, regionId: record.regionId, quote: record.quote, ske: record.ske, qualifiers: record.qualifiers, scope: [record.attribution,record.time,record.modality,record.polarity,record.world], entityMentions: record.entityMentions });
    records.push(record);
    candidateRecordIds.set(candidate.candidateId, record.id);
    receipts.push(makeReviewReceipt(record, { sessionId: result.sessionId, model: LUNA, reviewedAt: record.review.reviewedAt, decision: 'entailed' }));
  }
  for (const candidate of eligible) {
    const record = records.find(r => r.id === candidateRecordIds.get(candidate.candidateId));
    const review = reviews.get(candidate.candidateId);
    if (record && review) record.counterevidence = (review.counterevidence ?? []).map(id => candidateRecordIds.get(id)).filter(Boolean);
  }
  // Receipts bind the final reversible alias and counterevidence metadata too.
  receipts.splice(0, receipts.length, ...records.map(record => makeReviewReceipt(record, { sessionId: result.sessionId, model: LUNA, reviewedAt: record.review.reviewedAt, decision: 'entailed' })));
  onEvent?.({ type: 'ingestion.assertions-reviewed', model: LUNA, accepted: records.length, rejected: rejected.length, sessionId: result.sessionId });
  return { records, receipts, rejected, sessionId: result.sessionId, usage, wallMs, calls:repairCalls+1 };
}

function extractionPrompt(source, chunk) {
  const regions = chunk.regions.map(r => ({ regionId: r.id, locator: r.locator, text: r.text }));
  return `Extract only explicit, atomic factual propositions expressed in the source. SKE MUST use the exact parenthesized syntax accepted by the parser: a ground call such as (owns peter rabbit) or (ordered_to king doctors). Do not use function-call syntax, commas, prose, variables, or parentheses inside entity names. Use lowercase snake_case atoms for entity arguments; include their exact surface forms in entities so they can be bound to stable IDs. The predicate comes first. Do not infer missing relations or collapse attributed/modal/time-scoped claims. Cite exactly one supplied region per assertion and quote an exact substring from that region. Preserve who said it, when, possibility/necessity, and negative polarity. Propose entity surface mentions but do not merge identities. If there is no clear proposition, return an empty assertions list.\nSource version: ${sourceVersion(source)}\nRegions:\n${JSON.stringify(regions)}`;
}

function contextEntityKeys(record) {
  const keys=new Set();
  for(const mention of record.entityMentions??[]) {
    if(mention.entityId) keys.add(`id:${mention.entityId}`);
    for(const value of [mention.canonicalName,mention.surface]) if(typeof value==='string'&&value.trim()) keys.add(`name:${value.trim().toLocaleLowerCase()}`);
  }
  try {
    const ast=typeof record.ske==='string'?parseSKE(record.ske):record.ske;
    const visit=term=>{
      if(term?.type==='atom'&&term.value&&!/^\d+$/.test(term.value)&&!['true','false','unknown','null'].includes(term.value))keys.add(`name:${term.value.replaceAll('_',' ').toLocaleLowerCase()}`);
      else if(term?.type==='call')term.args.forEach(visit);
    };
    if(ast?.type==='call')ast.args.forEach(visit);
  } catch {}
  return keys;
}

function linkedCrossBatchPairs(batches, recordsById, limit=512) {
  const batchOf=new Map();for(let i=0;i<batches.length;i++)for(const r of batches[i])batchOf.set(r.id,i);
  const buckets=new Map();
  for(const r of recordsById.values())for(const key of contextEntityKeys(r)){if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(r);}
  const seen=new Set(),pairs=[];let total=0;
  for(const [key,rows] of buckets){
    for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
      const left=rows[i],right=rows[j];if(batchOf.get(left.id)===batchOf.get(right.id))continue;
      const ids=[left.id,right.id].sort();const pairKey=ids.join('\0');if(seen.has(pairKey))continue;seen.add(pairKey);total++;
      if(pairs.length<limit)pairs.push({pairId:`pair_${hash(pairKey).slice(0,20)}`,entityKey:key,recordIds:ids});
    }
  }
  return {pairs,total,truncated:total>limit,batchOf};
}

/** Whole-source, resumable extraction followed by a distinct Luna semantic-review turn. */
export async function ingestProject({ snapshot, sourceScope, session, checkpointDir, signal, onEvent, procedures = [], contextPairLimit = 512 } = {}) {
  if (!snapshot?.id || !Array.isArray(snapshot.sources) || !session?.request) throw new TypeError('Pinned snapshot, sources, and Luna session are required');
  if (!checkpointDir) throw new TypeError('checkpointDir is required for resumable ingestion');
  if(!Number.isInteger(contextPairLimit)||contextPairLimit<1||contextPairLimit>2048)throw new RangeError('contextPairLimit must be an integer from 1 through 2048');
  const sources = snapshot.sources.filter(s => scoped(s, sourceScope));
  if (!Array.isArray(sourceScope) || sources.length !== new Set(sourceScope).size) throw new Error('Source scope contains versions outside the pinned project snapshot');
  const activeProcedures = procedures.length ? procedures : snapshot.procedures ?? [];
  const fingerprint = checkpointFingerprint(snapshot, sourceScope, activeProcedures, { contextPairLimit });
  const checkpointFile = path.join(checkpointDir, 'ingestion-checkpoint.json'); await mkdir(checkpointDir, { recursive: true });
  let checkpoint;
  try { checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (checkpoint && checkpoint.fingerprint !== fingerprint) throw new Error('Ingestion checkpoint does not match the pinned snapshot, source scope, policy, reader profiles, or procedure versions');
  checkpoint ??= { version: 1, snapshotId: snapshot.id, fingerprint, chunks: {}, startedAt: new Date().toISOString(), sessionId: null };
  const records = [], receipts = [], coverage = [], rejected = []; let calls = 0; let partialError = null;
  for (const source of sources) {
    const sv = sourceVersion(source);
    for (const region of source.regions ?? []) coverage.push({ id: `cov_${hash(`${sv}:${region.id}`).slice(0,24)}`, sourceVersionId: sv, regionId: region.id, locator: region.locator, state: 'deferred', reviewState: 'unprocessed', reason: 'Awaiting whole-source extraction and review.' });
    for (const item of source.coverage?.deferred ?? []) if (item.state === 'unreadable' || item.state === 'deferred' || item.state === 'failed') coverage.push({ id: `cov_${hash(`${sv}:${JSON.stringify(item.locator)}`).slice(0,24)}`, sourceVersionId: sv, locator: item.locator, state: item.state === 'unreadable' || item.state === 'failed' ? 'unreadable' : 'deferred', reviewState: 'reader', reason: item.reason });
    if (!(source.regions ?? []).length && !(source.coverage?.deferred ?? []).length) coverage.push({ id: `cov_${hash(`${sv}:document`).slice(0,24)}`, sourceVersionId: sv, locator: { type: 'document' }, state: 'unreadable', reviewState: 'reader', reason: 'Reader produced no regions and no coverage detail.' });
  }
  for (const source of sources) {
    const sv = sourceVersion(source), chunks = chunkSourceRegions(source, { maxChars: 18_000 });
    for (const chunk of chunks) {
      if (signal?.aborted) throw new Error('Ingestion cancelled');
      const key = `${sv}:${chunk.id}`, previous = checkpoint.chunks[key];
      if (previous?.status === 'complete') {
        const cachedRecords=previous.records??[],cachedRejected=previous.rejected??[];
        records.push(...cachedRecords); receipts.push(...(previous.receipts??[])); rejected.push(...cachedRejected);
        const acceptedRegions=new Set(cachedRecords.map(r=>r.regionId));
        const rejectedRegionMap=new Map();for(const item of cachedRejected)if(item.regionId&&!['uncertain','not-entailed'].includes(item.reason))rejectedRegionMap.set(item.regionId,item.reason);
        coverage.push(...chunk.regions.map(region=>{const accepted=acceptedRegions.has(region.id),incomplete=!accepted&&rejectedRegionMap.has(region.id);return{id:`cov_${hash(`${sv}:${region.id}`).slice(0,24)}`,sourceVersionId:sv,regionId:region.id,locator:region.locator,state:incomplete?'partial':'processed',reviewState:accepted?'model-reviewed':incomplete?'rejected-candidates':'no-assertions',reason:accepted?'Luna extracted and separately reviewed source-grounded assertions.':incomplete?'A proposal did not reopen or complete review; see checkpoint rejection diagnostics and retry that chunk.':'Region was processed; propositions were absent or did not pass independent entailment review.'};}));continue;
      }
      try {
        const extraction = await session.request({ signal, schema: ASSERTION_SCHEMA, prompt: extractionPrompt(source, chunk) }); calls++;
        checkpoint.sessionId = extraction.sessionId; const output = outputObject(extraction.output, 'Assertion extraction');
        const allowedRegionIds = new Set(chunk.regions.map(r => r.id)); const candidates = [];
        for (let i = 0; i < (output.assertions ?? []).length; i++) {
          const raw = output.assertions[i];
          if (!allowedRegionIds.has(raw.regionId)) continue;
          candidates.push({ candidateId: `cand_${hash(`${key}:${raw.regionId}:${raw.ske}:${raw.quote}`).slice(0, 24)}`, sourceVersionId: sv, sourceId: source.sourceId,
            regionId: raw.regionId, quote: raw.quote, ske: raw.ske, qualifiers: raw.qualifiers ?? {}, entities: raw.entities ?? [] });
        }
        let reviewed = { records: [], receipts: [], rejected: [] };
        if (candidates.length) { reviewed = await reviewAssertions({ candidates, snapshot: { ...snapshot, records: [...snapshotRecords(snapshot), ...records] }, sourceScope, session, signal, onEvent }); calls += reviewed.calls ?? 1; checkpoint.sessionId = reviewed.sessionId ?? checkpoint.sessionId; }
        const assertionsByRegion = new Map();
        for (const record of reviewed.records) { if (!assertionsByRegion.has(record.regionId)) assertionsByRegion.set(record.regionId, []); assertionsByRegion.get(record.regionId).push(record.id); }
        const rejectedById = new Map(reviewed.rejected.map(x=>[x.candidateId,x.reason]));
        const rejectedRegionIds = new Set(candidates.filter(c=>rejectedById.has(c.candidateId)&&!['uncertain','not-entailed'].includes(rejectedById.get(c.candidateId))).map(c=>c.regionId));
        const chunkCoverage = chunk.regions.map(region => { const accepted=assertionsByRegion.has(region.id), incomplete= !accepted&&rejectedRegionIds.has(region.id); return ({ id: `cov_${hash(`${sv}:${region.id}`).slice(0, 24)}`, sourceVersionId: sv, regionId: region.id,
          locator: region.locator, state: incomplete ? 'partial' : 'processed', reviewState: accepted ? 'model-reviewed' : incomplete ? 'rejected-candidates' : 'no-assertions', reason: accepted ? 'Luna extracted and separately reviewed source-grounded assertions.' : incomplete ? 'A proposal did not reopen or complete review; see checkpoint rejection diagnostics and retry that chunk.' : 'Region was processed; propositions were absent or did not pass independent entailment review.' }); });
        const rejectedLedger=reviewed.rejected.map(item=>({...item,regionId:candidates.find(c=>c.candidateId===item.candidateId)?.regionId??null}));
        const entry = { status: 'complete', records: reviewed.records, receipts: reviewed.receipts, coverage: chunkCoverage, rejected: rejectedLedger, completedAt: new Date().toISOString(), extractionSessionId: extraction.sessionId, reviewSessionId: reviewed.sessionId ?? null, usage: [extraction.usage, reviewed.usage].filter(Boolean) };
        checkpoint.chunks[key] = entry; checkpoint.updatedAt = new Date().toISOString(); await atomicJson(checkpointFile, checkpoint);
        records.push(...entry.records); receipts.push(...entry.receipts); coverage.push(...entry.coverage); rejected.push(...entry.rejected);
        onEvent?.({ type: 'ingestion.chunk-completed', sourceVersionId: sv, chunkId: chunk.id, regions: chunk.regions.length, assertions: entry.records.length });
      } catch (error) {
        partialError = error.message;
        checkpoint.chunks[key] = { status: 'deferred', error: error.message, failedAt: new Date().toISOString() };
        checkpoint.updatedAt = new Date().toISOString(); await atomicJson(checkpointFile, checkpoint);
        onEvent?.({ type: 'ingestion.chunk-deferred', sourceVersionId: sv, chunkId: chunk.id, reason: error.message });
        break;
      }
    }
    if (partialError) break;
    // Reader-level failures such as blank/OCR-unreadable pages are retained in the final ledger.
    const coveredLocators = new Set((source.regions ?? []).map(r => JSON.stringify(r.locator)));
    for (const deferred of source.coverage?.deferred ?? []) if (deferred.state === 'unreadable' || (deferred.state !== 'readable' && !coveredLocators.has(JSON.stringify(deferred.locator)))) {
      coverage.push({ id: `cov_${hash(`${sv}:${JSON.stringify(deferred.locator)}`).slice(0, 24)}`, sourceVersionId: sv, locator: deferred.locator,
        state: deferred.state === 'unreadable' ? 'unreadable' : 'deferred', reviewState: 'reader', reason: deferred.reason ?? 'Reader could not extract this source region.' });
    }
    for (const deferred of source.coverage?.deferred ?? []) if (deferred.state === 'readable' && !coveredLocators.has(JSON.stringify(deferred.locator))) {
      coverage.push({ id: `cov_${hash(`${sv}:${JSON.stringify(deferred.locator)}`).slice(0, 24)}`, sourceVersionId: sv, locator: deferred.locator, state: 'deferred', reviewState: 'reader', reason: deferred.reason });
    }
    if (!chunks.length) for (const deferred of source.coverage?.deferred ?? []) if (!coverage.some(c => c.sourceVersionId === sv && JSON.stringify(c.locator) === JSON.stringify(deferred.locator))) {
      coverage.push({ id: `cov_${hash(`${sv}:${JSON.stringify(deferred.locator)}`).slice(0, 24)}`, sourceVersionId: sv, locator: deferred.locator, state: 'unreadable', reason: deferred.reason ?? 'No readable regions were produced.' });
    }
  }
  let contextError = null;
  const sourceAssertions = records.filter(r => r.type === 'source-assertion' && r.supportState === 'supported');
  if (!partialError && sourceAssertions.length) {
    const recordById=new Map(sourceAssertions.map(r=>[r.id,r]));
    const batches=[];let batch=[],chars=0;
    for(const r of sourceAssertions){const size=JSON.stringify({id:r.id,ske:r.ske,quote:r.quote,source:r.sourceVersionId,region:r.regionId,qualifiers:r.qualifiers}).length;if(batch.length&&(batch.length>=100||chars+size>36_000)){batches.push(batch);batch=[];chars=0;}batch.push(r);chars+=size;}
    if(batch.length)batches.push(batch);
    const prior=checkpoint.context??{},contextRecords=prior.status==='complete'?[...(prior.records??[])]:[],contextReceipts=prior.status==='complete'?[...(prior.receipts??[])]:[];
    try {
      if(prior.status!=='complete'){
        for(let i=0;i<batches.length;i++){
          const ids=new Set(batches[i].map(r=>r.id));
          const schema={type:'object',additionalProperties:false,required:['relations'],properties:{relations:{type:'array',maxItems:60,items:{type:'object',additionalProperties:false,required:['relationship','summary','premiseIds','counterevidenceIds'],properties:{relationship:{type:'string',enum:['cross-chapter-dependency','exception','contradiction','temporal-revision','attribution-difference','recurring-pattern','unresolved-identity']},summary:{type:'string'},premiseIds:{type:'array',minItems:2,items:{type:'string',enum:[...ids]}},counterevidenceIds:{type:'array',items:{type:'string',enum:[...ids]}}}}}}};
          const input=batches[i].map(r=>({id:r.id,ske:r.ske,qualifiers:r.qualifiers,quote:r.quote,sourceVersionId:r.sourceVersionId,regionId:r.regionId}));
          const result=await session.request({signal,schema,prompt:`Within-batch cross-chapter context pass over reviewed source assertions. Identify only relationships directly supported by comparing the supplied passages: exceptions, revisions, attribution differences, contradictions, recurring patterns, or unresolved identities. Cite exact assertion IDs. Do not turn thematic similarity into factual entailment; every output remains an unresolved synthesis for inspection.\n${JSON.stringify(input)}`});calls++;
          for(const relation of outputObject(result.output,'Context pass').relations??[]){
            const premises=[...new Set(relation.premiseIds??[])],counters=[...new Set(relation.counterevidenceIds??[])];
            if(premises.length<2||[...premises,...counters].some(id=>!ids.has(id))||new Set(premises.map(id=>recordById.get(id)?.regionId)).size<2)continue;
            const record={id:`context_${hash(`${snapshot.id}:within:${i}:${relation.relationship}:${premises.join(',')}:${relation.summary}`).slice(0,26)}`,type:'contextual-finding',relationship:relation.relationship,summary:String(relation.summary),premiseIds:premises,counterevidenceIds:counters,dependencies:[...new Set([...premises,...counters])],evidenceIds:premises,sourceSnapshotId:snapshot.id,lifecycle:'current',supportState:'unresolved',validation:'model-reviewed',review:{model:LUNA,sessionId:result.sessionId,reviewedAt:new Date().toISOString(),method:'within-batch-cross-chapter-context-pass'}};
            contextRecords.push(record);contextReceipts.push(makeContextReviewReceipt(record,{sessionId:result.sessionId,model:LUNA,reviewedAt:record.review.reviewedAt}));
          }
          onEvent?.({type:'ingestion.context-batch',index:i+1,batches:batches.length,findings:contextRecords.length,sessionId:result.sessionId});
        }
      }
      let crossBatchAnalysis=batches.length<=1?'not-needed':prior.crossBatchAnalysis;
      let crossBatchCandidates=Number(prior.crossBatchCandidates)||0, crossBatchReviewedPairs=Number(prior.crossBatchReviewedPairs)||0, crossBatchOmittedPairs=Number(prior.crossBatchOmittedPairs)||0;
      if(batches.length>1&& !['complete','complete-no-linked-pairs','resource-limited'].includes(crossBatchAnalysis)){
        const linked=linkedCrossBatchPairs(batches,recordById,contextPairLimit),candidatePairs=linked.pairs;crossBatchCandidates=linked.total;crossBatchOmittedPairs=Math.max(0,linked.total-candidatePairs.length);
        const pairGroups=[];for(let i=0;i<candidatePairs.length;i+=8)pairGroups.push(candidatePairs.slice(i,i+8));
        for(let groupIndex=0;groupIndex<pairGroups.length;groupIndex++){
          const group=pairGroups[groupIndex],pairById=new Map(group.map(pair=>[pair.pairId,pair]));
          const allowedIds=[...new Set(group.flatMap(pair=>pair.recordIds))];
          const schema={type:'object',additionalProperties:false,required:['relations'],properties:{relations:{type:'array',maxItems:group.length,items:{type:'object',additionalProperties:false,required:['pairId','relationship','summary','premiseIds','counterevidenceIds'],properties:{pairId:{type:'string',enum:group.map(p=>p.pairId)},relationship:{type:'string',enum:['cross-chapter-dependency','exception','contradiction','temporal-revision','attribution-difference','recurring-pattern','unresolved-identity']},summary:{type:'string'},premiseIds:{type:'array',minItems:2,maxItems:2,items:{type:'string',enum:allowedIds}},counterevidenceIds:{type:'array',items:{type:'string',enum:allowedIds}}}}}}};
          const input=group.map(pair=>({pairId:pair.pairId,linkKey:pair.entityKey,assertions:pair.recordIds.map(id=>{const r=recordById.get(id);return{id:r.id,ske:r.ske,qualifiers:r.qualifiers,quote:r.quote,sourceVersionId:r.sourceVersionId,regionId:r.regionId,locator:r.locator};})}));
          const result=await session.request({signal,schema,prompt:`Bounded cross-batch context synthesis over linked, separately reviewed source assertions from different initial context batches. A pair is linked only by a shared reviewed entity ID, canonical entity alias, or exact SKE argument term. Examine every supplied pair. Emit a relationship only when the two exact source assertions and quotes support it; otherwise omit it. Preserve relation direction, qualifiers, and counterevidence. Do not infer a new source fact. Each accepted output is an unresolved contextual synthesis, not a supported assertion. Cite the exact two premise IDs and any counterevidence IDs from that pair.\nCandidate assertion pairs:\n${JSON.stringify(input)}`});calls++;
          for(const relation of outputObject(result.output,'Cross-batch context synthesis').relations??[]){
            const pair=pairById.get(relation.pairId),premises=[...new Set(relation.premiseIds??[])],counters=[...new Set(relation.counterevidenceIds??[])];
            if(!pair||premises.length!==2||pair.recordIds.some(id=>!premises.includes(id))||counters.some(id=>!pair.recordIds.includes(id))||new Set(pair.recordIds.map(id=>linked.batchOf.get(id))).size!==2)continue;
            const record={id:`context_${hash(`${snapshot.id}:cross:${pair.pairId}:${relation.relationship}:${relation.summary}`).slice(0,26)}`,type:'contextual-finding',relationship:relation.relationship,summary:String(relation.summary),premiseIds:premises,counterevidenceIds:counters,dependencies:[...new Set([...premises,...counters])],evidenceIds:premises,sourceSnapshotId:snapshot.id,lifecycle:'current',supportState:'unresolved',validation:'model-reviewed',review:{model:LUNA,sessionId:result.sessionId,reviewedAt:new Date().toISOString(),method:'cross-batch-linked-context-synthesis'}};
            contextRecords.push(record);contextReceipts.push(makeContextReviewReceipt(record,{sessionId:result.sessionId,model:LUNA,reviewedAt:record.review.reviewedAt}));
          }
          crossBatchReviewedPairs+=group.length;
          onEvent?.({type:'ingestion.cross-batch-context',index:groupIndex+1,batches:pairGroups.length,pairs:group.length,findings:contextRecords.length,sessionId:result.sessionId});
        }
        crossBatchAnalysis=linked.truncated?'resource-limited':candidatePairs.length?'complete':'complete-no-linked-pairs';
      }
      checkpoint.context={status:'complete',records:contextRecords,receipts:contextReceipts,batches:batches.length,crossBatchAnalysis,crossBatchCandidates,crossBatchReviewedPairs,crossBatchOmittedPairs,completedAt:new Date().toISOString()};
      await atomicJson(checkpointFile,checkpoint);records.push(...contextRecords);receipts.push(...contextReceipts);
    } catch(error){contextError=error.message;checkpoint.context={...prior,records:contextRecords,receipts:contextReceipts,status:'deferred',error:contextError,failedAt:new Date().toISOString()};await atomicJson(checkpointFile,checkpoint);}
  }
  const uniqueRecords = [...new Map(records.map(r => [r.id, r])).values()], uniqueCoverage = [...new Map(coverage.map(c => [c.id, c])).values()];
  const pinnedById=new Map(snapshotRecords(snapshot).map(r=>[r.id,r]));
  const publishRecords=uniqueRecords.filter(record=>{
    const pinned=pinnedById.get(record.id); if(!pinned) return true;
    const semantic=x=>JSON.stringify({id:x.id,type:x.type,ske:x.ske,sourceVersionId:x.sourceVersionId,sourceId:x.sourceId,regionId:x.regionId,quote:x.quote,qualifiers:x.qualifiers,entityMentions:(x.entityMentions??[]).map(m=>({surface:m.surface,canonicalName:m.canonicalName,entityId:m.entityId,kind:m.kind,reconciledFrom:m.reconciledFrom})),counterevidence:x.counterevidence,dependencies:x.dependencies,procedureId:x.procedureId,procedureVersion:x.procedureVersion,relationship:x.relationship,summary:x.summary,premiseIds:x.premiseIds});
    if(semantic(pinned)!==semantic(record)) throw new Error(`Ingestion generated a conflicting existing record ID ${record.id}`);
    return false;
  });
  checkpoint.status = partialError ? 'partial' : 'complete'; checkpoint.completedAt = partialError ? null : new Date().toISOString();
  await atomicJson(checkpointFile, checkpoint);
  const evidence = uniqueRecords.filter(r => r.type === 'source-assertion').map(r => ({ id: r.id, type: 'source', sourceVersionId: r.sourceVersionId, regionId: r.regionId, quote: r.quote, ske: r.ske, qualifiers: r.qualifiers }));
  for (const context of uniqueRecords.filter(r => r.type === 'contextual-finding')) for (const id of [...context.premiseIds,...context.counterevidenceIds]) {
    const premise = uniqueRecords.find(r => r.id === id); const source = premise && sources.find(s => sourceVersion(s) === premise.sourceVersionId); const region = source?.regions?.find(x => x.id === premise.regionId);
    if (premise && region) evidence.push({ id:premise.id,type:'source',sourceVersionId:premise.sourceVersionId,regionId:premise.regionId,quote:premise.quote,ske:premise.ske,qualifiers:premise.qualifiers });
  }
  const uniqueEvidence = [...new Map(evidence.map(e => [e.id,e])).values()];
  const incompleteCoverage=uniqueCoverage.filter(c=>c.state!=='processed');
  const partialStatus=Boolean(partialError||contextError||incompleteCoverage.length||checkpoint.context?.crossBatchAnalysis==='resource-limited');
  return {
    answerPackage: { answer: partialStatus ? 'Ingestion is partial; see coverage and residuals.' : 'Source regions were processed with separate model review.', claims: [], interpretation: null, supportState: partialStatus ? 'partial' : 'unresolved', coverage: { regions: uniqueCoverage.length, incompleteRegions:incompleteCoverage.length,contextBatches:checkpoint.context?.batches??null,crossBatchAnalysis:checkpoint.context?.crossBatchAnalysis??'deferred',crossBatchCandidatePairs:checkpoint.context?.crossBatchCandidates??0,crossBatchPairsExamined:checkpoint.context?.crossBatchReviewedPairs??0,crossBatchPairsOmitted:checkpoint.context?.crossBatchOmittedPairs??0 }, procedureVersions: activeProcedures.map(p => ({ id: p.id, version: p.version })), snapshotId: snapshot.id, residuals: [...(partialError ? [{ reason: partialError }] : []), ...(contextError ? [{ reason: `Cross-chapter context pass deferred: ${contextError}` }] : []), ...(checkpoint.context?.crossBatchAnalysis==='resource-limited'?[{reason:`Cross-batch context synthesis reached its configured pair limit (${checkpoint.context.crossBatchReviewedPairs} examined; ${checkpoint.context.crossBatchOmittedPairs} linked pairs remain). Increase contextPairLimit and resume against a newly fingerprinted checkpoint.`}]:[]), ...(incompleteCoverage.length?[{reason:`${incompleteCoverage.length} source coverage entries are partial, unreadable, or deferred.`}]:[])] },
    evidence: uniqueEvidence, coverage: uniqueCoverage,
    changeSet: { records: publishRecords, coverage: uniqueCoverage },
    reviewReceipts: receipts.filter(receipt=>publishRecords.some(record=>record.id===receipt.recordId)),
    validation: { status: partialStatus ? 'partial' : 'model-reviewed', model: LUNA, calls, sessionId: checkpoint.sessionId, reviewedAssertions: uniqueRecords.filter(r => r.validation === 'model-reviewed').length, deterministicAssertions: uniqueRecords.filter(r => r.validation === 'source-checked').length, contextFindings: uniqueRecords.filter(r => r.type === 'contextual-finding').length, rejectedCandidates: rejected.length, idempotentRecords:uniqueRecords.length-publishRecords.length, incompleteCoverage:incompleteCoverage.length, semanticExtraction: true, humanReview: false },
    checkpoint: { path: checkpointFile, fingerprint, completedChunks: Object.values(checkpoint.chunks).filter(x => x.status === 'complete').length, pendingChunks: Object.values(checkpoint.chunks).filter(x => x.status !== 'complete').length }
  };
}

/** Re-run version-pinned procedure materialization over selected, supported assertions. */
export async function materializeProcedures({ snapshot, procedures, procedureIds, parameters = {}, sourceScope, session, checkpointDir, signal, onEvent } = {}) {
  if (!snapshot?.id || !session?.request || !Array.isArray(snapshot.sources)) throw new TypeError('Pinned snapshot and Luna session are required');
  const pinnedProcedures=snapshot.procedures??[];
  let requested;
  if (procedureIds?.length) requested=procedureIds;
  else if (procedures?.length) requested=procedures;
  else requested=pinnedProcedures.filter(p=>p.active!==false);
  const selected=[];
  for (const item of requested) {
    if (typeof item==='string') throw new Error(`Procedure selection ${item} requires an exact pinned version`);
    if (!item?.id || !item?.version) throw new Error('Procedure materialization requires exact procedure ID and version');
    const pinned=pinnedProcedures.find(p=>p.id===item.id&&String(p.version)===String(item.version));
    if (!pinned || pinned.active===false) throw new Error(`Procedure ${item.id}@${item.version} is not the active exact version pinned to this snapshot`);
    if (!selected.some(p=>p.id===pinned.id&&String(p.version)===String(pinned.version))) selected.push(pinned);
  }
  const scopeMap = regionMap(snapshot, sourceScope), recordMap=new Map(snapshotRecords(snapshot).map(r=>[r.id,r]));
  const eligibleState=new Map();
  function eligible(record,visiting=new Set()) {
    if(!record||eligibleState.get(record.id)===false||['stale','retracted','superseded','staged','deferred'].includes(record.lifecycle)||record.supportState!=='supported') return false;
    if(!['source-checked','model-reviewed','human-approved','rule-replayed','semantically-reviewed','valid','trusted'].includes(record.validation)) return false;
    if(visiting.has(record.id)) return false;
    if(!record.sourceVersionId||!record.regionId||!scopeMap.regions.has(`${record.sourceVersionId}:${record.regionId}`)) return false;
    visiting.add(record.id);
    for(const dependency of record.dependencies??[]) {
      const dep=recordMap.get(dependency);
      if(!dep||!eligible(dep,visiting)) { visiting.delete(record.id); eligibleState.set(record.id,false); return false; }
    }
    visiting.delete(record.id); eligibleState.set(record.id,true); return true;
  }
  const supported = snapshotRecords(snapshot).filter(r => r.ske && eligible(r));
  const findings = [], evidence = [], coverage = [], reviewReceipts = [];
  const sourceRegionsAll=(snapshot.sources??[]).filter(s=>scoped(s,sourceScope)).flatMap(source=>(source.regions??[]).map(region=>({...region,sourceVersionId:sourceVersion(source),sourceId:source.sourceId,sourceName:source.name,workBoundaries:source.workBoundaries??null})));
  const hasWorkBoundaries=sourceRegionsAll.some(r=>['project-gutenberg-work-v1','project-gutenberg-work-v2'].includes(r.workBoundaries?.type));
  const sourceRegions=hasWorkBoundaries?sourceRegionsAll.filter(r=>r.sourceSegment==='work'):sourceRegionsAll;
  const chunks=chunkSourceRegions({regions:sourceRegions},{maxChars:18_000});
  const recordEvidenceFor = record => {
    const pair = scopeMap.regions.get(`${record.sourceVersionId}:${record.regionId}`);
    return pair ? { id: record.id, type: 'source', sourceVersionId: record.sourceVersionId, regionId: record.regionId, quote: pair.region.text, ske: record.ske, qualifiers: record.qualifiers } : null;
  };
  const passageEvidence = region => ({id:`passage_${hash(`${region.sourceVersionId}:${region.id}`).slice(0,24)}`,type:'source',sourceVersionId:region.sourceVersionId,regionId:region.id,quote:region.text});
  const recordByRegion=new Map();for(const r of supported){const k=`${r.sourceVersionId}:${r.regionId}`;if(!recordByRegion.has(k))recordByRegion.set(k,[]);recordByRegion.get(k).push(r);}
  const activeProcedures = selected.length ? selected : [];
  for (const procedure of activeProcedures) {
    if (!procedure.id || !procedure.version) throw new Error('Procedure materialization requires an exact pinned id and version');
    const params=structuredClone(parameters[procedure.id]??parameters),parameterFingerprint=hash(stableJson(params));
    if(hasWorkBoundaries)for(const r of sourceRegionsAll.filter(x=>x.sourceSegment!=='work'))coverage.push({id:procedureCoverageId(procedure,r.sourceVersionId,r.id,parameterFingerprint),sourceVersionId:r.sourceVersionId,regionId:r.id,procedureId:procedure.id,procedureVersion:String(procedure.version),parameters:structuredClone(params),parameterFingerprint,state:'intentionally-excluded',reviewState:'source-boundary-policy',reason:`Excluded ${r.sourceSegment??'unclassified'} text outside explicit Project Gutenberg START/END markers; original source region remains reopenable.`});
    let procedureFindingCount=0;
    for(const chunk of chunks){
      const passages=chunk.regions.map(passageEvidence), localRecords=chunk.regions.flatMap(r=>recordByRegion.get(`${r.sourceVersionId}:${r.id}`)??[]);
      const facts=localRecords.map(r=>({recordId:r.id,ske:r.ske,sourceVersionId:r.sourceVersionId,regionId:r.regionId,quote:r.quote,qualifiers:r.qualifiers}));
      const allowedRows=[...passages,...localRecords.map(recordEvidenceFor).filter(Boolean)], byEvidenceId=new Map(allowedRows.map(e=>[e.id,e]));
      const prompt=`Apply this exact pinned procedure over every supplied narrative/work passage in chunk ${chunk.id}, including passages without accepted structured facts. Do not add claims from prior knowledge. Treat raw passages as source text, not as pre-reviewed semantic assertions. Every finding must cite only supplied evidence IDs; include passages supporting the assessment and relevant contradictory/counter evidence. Label each output as a procedural assessment, never a strict fact or expert judgment. Echo exact chunkId. Mark reviewStatus complete only if every supplied region was reviewed. Otherwise list every unreviewed region ID; the server records coverage over the actual supplied set. Source line offsets remain absolute and reopenable. Procedure JSON: ${JSON.stringify(procedure)}\nParameters: ${JSON.stringify(params)}\nWork passages:\n${JSON.stringify(chunk.regions.map((r,i)=>({evidenceId:passages[i].id,sourceVersionId:r.sourceVersionId,regionId:r.id,locator:r.locator,sourceSegment:r.sourceSegment??null,sourceOffsets:{start:r.locator?.start??null,end:r.locator?.end??null},quote:r.text,fidelityCaveat:r.fidelityCaveat??null}))) }\nSeparately accepted structured assertions in these regions:\n${JSON.stringify(facts)}`;
      const ids=[...byEvidenceId.keys()];
      const regionIds=chunk.regions.map(r=>r.id);
      const schema={type:'object',additionalProperties:false,required:['chunkId','findings','coverage'],properties:{chunkId:{type:'string',enum:[chunk.id]},findings:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,required:['summary','evidenceIds','counterevidenceIds','supportState','score','criterion'],properties:{summary:{type:'string'},evidenceIds:{type:'array',minItems:1,items:{type:'string',enum:ids}},counterevidenceIds:{type:'array',items:{type:'string',enum:ids}},supportState:{type:'string',enum:['supported','contested','unresolved']},score:{type:['number','null']},criterion:{type:['string','null']}}}},coverage:{type:'object',additionalProperties:false,required:['reviewStatus','unreviewedRegionIds'],properties:{reviewStatus:{type:'string',enum:['complete','partial']},unreviewedRegionIds:{type:'array',items:{type:'string',enum:regionIds}}}}}};
      if(!ids.length){for(const r of chunk.regions)coverage.push({id:procedureCoverageId(procedure,r.sourceVersionId,r.id,parameterFingerprint),sourceVersionId:r.sourceVersionId,regionId:r.id,procedureId:procedure.id,procedureVersion:String(procedure.version),parameters:structuredClone(params),parameterFingerprint,state:'unreadable',reviewState:'reader',reason:'No reopenable source passage evidence was available.'});continue;}
      const result=await session.request({signal,schema,prompt}),output=outputObject(result.output,`Procedure ${procedure.id}`), reviewedAt=new Date().toISOString();
      const chunkValid=output.chunkId===chunk.id,unreviewed=new Set(output.coverage?.unreviewedRegionIds??[]),complete=chunkValid&&output.coverage?.reviewStatus==='complete'&&unreviewed.size===0,partialReported=chunkValid&&output.coverage?.reviewStatus==='partial'&&unreviewed.size>0,coverageValid=complete||partialReported;
      for(const r of chunk.regions){const regionComplete=coverageValid&&!unreviewed.has(r.id);coverage.push({id:procedureCoverageId(procedure,r.sourceVersionId,r.id,parameterFingerprint),sourceVersionId:r.sourceVersionId,regionId:r.id,procedureId:procedure.id,procedureVersion:String(procedure.version),parameters:structuredClone(params),parameterFingerprint,state:regionComplete?'processed':'partial',reviewState:regionComplete?'model-reviewed':'incomplete-review',reason:regionComplete?`Complete passage supplied in ${chunk.id} and reviewed.`:`Region was explicitly left unreviewed or chunk binding/coverage declaration was invalid in ${chunk.id}.`});}
      for(const finding of output.findings??[]){
        const cited=[...new Set(finding.evidenceIds??[])],counter=[...new Set(finding.counterevidenceIds??[])];
        if(!cited.length||[...cited,...counter].some(id=>!byEvidenceId.has(id)))continue;
        const citedEvidence=[...new Set([...cited,...counter])].map(id=>byEvidenceId.get(id));
        if(!coverageValid||citedEvidence.some(e=>unreviewed.has(e.regionId)))continue;
        const sourceDependencies=[...new Set(citedEvidence.map(e=>e.sourceVersionId))];
        const id=`finding_${hash(`${snapshot.id}:${procedure.id}@${procedure.version}:${chunk.id}:${JSON.stringify(params)}:${cited.join(',')}:${counter.join(',')}:${finding.summary}`).slice(0,28)}`;
        const record={id,type:'procedure-finding',procedureId:procedure.id,procedureVersion:procedure.version,parameters:structuredClone(params),summary:String(finding.summary),score:Number.isFinite(finding.score)?finding.score:null,criterion:finding.criterion??null,evidenceIds:cited,counterevidenceIds:counter,dependencies:[...new Set([...cited,...counter,...sourceDependencies])],sourceSnapshotId:snapshot.id,lifecycle:'current',supportState:finding.supportState==='contested'?'contested':'unresolved',validation:'model-reviewed',review:{model:LUNA,sessionId:result.sessionId,reviewedAt,method:'whole-source-procedure-application'}};
        findings.push(record);procedureFindingCount++;reviewReceipts.push(makeProcedureReviewReceipt(record,{sessionId:result.sessionId,model:LUNA,reviewedAt}));evidence.push(...citedEvidence);
      }
      onEvent?.({type:'procedure.chunk-reviewed',procedureId:procedure.id,procedureVersion:procedure.version,chunkId:chunk.id,regions:chunk.regions.length,findings:procedureFindingCount,complete,reviewed:regionIds.length-unreviewed.size,unreviewed:unreviewed.size,sessionId:result.sessionId});
    }
    for(const source of snapshot.sources.filter(s=>scoped(s,sourceScope)))for(const d of source.coverage?.deferred??[])if(d.state==='unreadable'||d.state==='deferred')coverage.push({id:procedureCoverageId(procedure,sourceVersion(source),stableJson(d.locator),parameterFingerprint),sourceVersionId:sourceVersion(source),locator:d.locator,procedureId:procedure.id,procedureVersion:String(procedure.version),parameters:structuredClone(params),parameterFingerprint,state:d.state==='unreadable'?'unreadable':'deferred',reviewState:'reader',reason:d.reason??'Reader did not provide source text for this region.'});
    onEvent?.({ type: 'procedure.materialized', procedureId: procedure.id, procedureVersion: procedure.version, findings: procedureFindingCount });
  }
  const incompleteProcedureRegions=coverage.filter(c=>!['processed','intentionally-excluded'].includes(c.state)).length;
  const intentionallyExcludedRegions=coverage.filter(c=>c.state==='intentionally-excluded').length;
  const package_ = { answer: `${findings.length} procedural assessments recorded from complete in-scope work passages and structured source evidence.`, claims: [], interpretation: null, supportState: findings.some(f => f.supportState === 'contested') ? 'contested' : 'unresolved', coverage: { findings: findings.length, procedures: activeProcedures.length, sourceRegions:sourceRegions.length,totalSourceRegions:sourceRegionsAll.length,intentionallyExcludedRegions,incompleteRegions:incompleteProcedureRegions }, procedureVersions: activeProcedures.map(p => ({ id: p.id, version: p.version })), snapshotId: snapshot.id, residuals: [...(sourceRegions.length ? [] : [{ reason: 'No in-scope readable work passages are available.' }]),...(intentionallyExcludedRegions?[{reason:`${intentionallyExcludedRegions} front-matter or back-matter regions were intentionally excluded by the detected Project Gutenberg work boundary; the original regions remain reopenable.`}]:[]),...(incompleteProcedureRegions?[{reason:`${incompleteProcedureRegions} selected work regions have incomplete, unreadable, or deferred procedure coverage.`}]:[])] };
  const recordEvidence = [...new Map(evidence.map(e => [e.id, e])).values()];
  return { answerPackage: package_, evidence: recordEvidence, coverage, changeSet: { records: findings, coverage }, reviewReceipts, validation: { status: incompleteProcedureRegions?'partial':'model-reviewed', model: LUNA, humanReview: false, findings: findings.length, procedureVersions: package_.procedureVersions,regionsConsidered:sourceRegions.length,totalSourceRegions:sourceRegionsAll.length,intentionallyExcludedRegions,incompleteRegions:incompleteProcedureRegions } };
}
