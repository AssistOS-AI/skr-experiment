import { createHash } from 'node:crypto';
import { parseSKE, printSKE, reason } from '../engine/index.mjs';
import { contextReviewFingerprint, procedureReviewFingerprint, reviewFingerprint } from '../ingestion/receipts.mjs';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = new Set(['deferred', 'intentionally-excluded', 'processed', 'unreadable', 'failed', 'partial', 'readable', 'model-reviewed', 'reviewed-no-assertions']);
const TASK_KEYS = {
  QUESTION: new Set(),
  INGEST_SOURCE: new Set(['records', 'coverage']),
  APPLY_PROCEDURE: new Set(['records', 'coverage']),
  BUILD_PROCEDURE: new Set(['procedures', 'records', 'coverage']),
  AUDIT_PROJECT: new Set(['records', 'coverage']),
  EVALUATE: new Set()
};

function fail(message) { throw new Error(`Invalid change set: ${message}`); }
function safeId(value, label) { if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} must be a safe opaque ID`); }
function isActive(record) { return !['stale','retracted','superseded','staged','deferred'].includes(record?.lifecycle); }
function stableStringify(value) { return Array.isArray(value) ? `[${value.map(stableStringify).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}` : JSON.stringify(value); }

/** Validate and copy agent-proposed project changes against one pinned snapshot and source scope. */
export function validateChangeSet({ changeSet, taskType, snapshot, sourceScope, evidence = [], reviewReceipts = [] } = {}) {
  if (!changeSet || typeof changeSet !== 'object' || Array.isArray(changeSet)) fail('changeSet must be an object');
  if (!snapshot || typeof snapshot.id !== 'string' || !Array.isArray(snapshot.sources)) fail('pinned snapshot is required');
  const allowedKeys = TASK_KEYS[taskType];
  if (!allowedKeys) fail(`unsupported task type ${String(taskType)}`);
  for (const key of Object.keys(changeSet)) if (!allowedKeys.has(key)) fail(`task ${taskType} cannot publish ${key}`);
  const output = structuredClone(changeSet);
  for (const key of ['records', 'procedures', 'coverage']) if (output[key] !== undefined && !Array.isArray(output[key])) fail(`${key} must be an array`);
  output.records ??= [];
  output.procedures ??= [];
  output.coverage ??= [];
  output.coverage = output.coverage.map(item => item?.id ? item : {
    ...item,
    id: `coverage_${createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 24)}`
  });

  const scopedSources = snapshot.sources.filter(s => !sourceScope || sourceScope.includes(s.id) || sourceScope.includes(s.sourceVersionId) || sourceScope.includes(s.sourceId));
  const sourceByVersion = new Map(scopedSources.flatMap(s => [[s.id, s], [s.sourceVersionId, s]].filter(([id]) => id)));
  const regionByKey = new Map();
  for (const s of scopedSources) for (const r of s.regions ?? []) regionByKey.set(`${s.sourceVersionId ?? s.id}:${r.id}`, { source: s, region: r });
  const pinnedRecords = new Map((snapshot.records ?? []).map(r => [r.id, r]));
  const stagedRecords = new Map();
  const evidenceById = new Map();
  for (const item of evidence) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || evidenceById.has(item.id)) fail('evidence entries require unique IDs');
    evidenceById.set(item.id, item);
  }
  const procedures = [...(snapshot.procedures ?? []), ...output.procedures];
  const procByVersion = new Map(procedures.filter(p => p.active !== false).map(p => [`${p.id}@${p.version}`, p]));
  const receiptsById = new Map(reviewReceipts.map(r => [r.recordId, r]));

  for (const proc of output.procedures) {
    safeId(proc?.id, 'procedure id');
    if (typeof proc.version !== 'string' || !proc.version.trim()) fail(`procedure ${proc.id} requires an exact version`);
    if (typeof proc.purpose !== 'string' || !proc.purpose.trim() || typeof proc.type !== 'string' || !proc.type.trim()) fail(`procedure ${proc.id}@${proc.version} requires purpose and type`);
    const complete = Array.isArray(proc.ordered_steps) && proc.ordered_steps.length > 0 && proc.ordered_steps.every(x => typeof x === 'string' && x.trim())
      && Array.isArray(proc.evidence_obligations) && proc.evidence_obligations.length > 0 && proc.evidence_obligations.every(x => typeof x === 'string' && x.trim())
      && proc.output_schema && typeof proc.output_schema === 'object' && !Array.isArray(proc.output_schema);
    const draft = proc.lifecycle === 'draft' && proc.validation === 'unreviewed' && proc.active === false;
    if (!complete && !draft) fail(`procedure ${proc.id}@${proc.version} needs ordered_steps, evidence_obligations and output_schema, or must be an inactive unreviewed draft`);
    if (procedures.filter(p => p.id === proc.id && p.version === proc.version).length > 1) fail(`duplicate procedure version ${proc.id}@${proc.version}`);
  }
  if (taskType === 'APPLY_PROCEDURE') {
    const requested = snapshot.selectedProcedure ?? snapshot.activeProcedure;
    if (requested && !procByVersion.has(`${requested.id}@${requested.version}`)) fail('applied procedure is not pinned to this snapshot');
  }

  for (const record of output.records) {
    safeId(record?.id, 'record id');
    if (stagedRecords.has(record.id) || pinnedRecords.has(record.id)) fail(`record id is not unique: ${record.id}`);
    if (record.ske !== undefined) {
      let ast;
      try { ast = typeof record.ske === 'string' ? parseSKE(record.ske) : record.ske; printSKE(ast); }
      catch (error) { fail(`record ${record.id} has invalid SKE (${error.message})`); }
      if (ast?.type !== 'call' || JSON.stringify(ast).includes('"type":"variable"')) fail(`record ${record.id} SKE must be a ground predicate expression`);
    }
    if (record.lifecycle === 'stale' || record.lifecycle === 'retracted' || record.lifecycle === 'superseded') fail(`record ${record.id} cannot publish with lifecycle ${record.lifecycle}`);
    if (record.sourceVersionId !== undefined || record.sourceId !== undefined) {
      const source = record.sourceVersionId !== undefined ? sourceByVersion.get(record.sourceVersionId) : scopedSources.find(s => s.sourceId === record.sourceId);
      if (!source) fail(`record ${record.id} cites a source outside the authorized scope`);
      if (record.sourceVersionId && record.sourceId && source.sourceId !== record.sourceId) fail(`record ${record.id} has inconsistent source IDs`);
      const sourceVersionId = source.sourceVersionId ?? source.id;
      const region = regionByKey.get(`${sourceVersionId}:${record.regionId}`)?.region;
      if (!record.regionId || !region) fail(`record ${record.id} does not reopen a region in the pinned source`);
      if (record.quote !== undefined && (typeof record.quote !== 'string' || !record.quote || !region.text.includes(record.quote))) fail(`record ${record.id} quote does not reopen in its region`);
      if (record.ske !== undefined) {
        const sourceText = region.text.trim();
        let sourceAst;
        try { sourceAst = parseSKE(sourceText); } catch { sourceAst = null; }
        const recordAst = typeof record.ske === 'string' ? parseSKE(record.ske) : record.ske;
        const exact = sourceAst?.type === 'call' && !JSON.stringify(sourceAst).includes('"type":"variable"')
          && printSKE(sourceAst) === printSKE(recordAst)
          && (record.quote === undefined || record.quote.trim() === region.text.trim());
        const receipt = receiptsById.get(record.id);
        const modelReviewed = !exact && record.validation === 'model-reviewed' && record.supportState === 'supported' && receipt
          && receipt.decision === 'entailed' && receipt.model === 'gpt-6-luna'
          && receipt.sourceVersionId === sourceVersionId && receipt.regionId === record.regionId
          && receipt.fingerprint === reviewFingerprint(record)
          && record.review?.sessionId === receipt.sessionId && record.review?.model === receipt.model;
        if (record.supportState === 'supported' && !exact && !modelReviewed) fail(`source interpretation ${record.id} cannot self-assert semantic support; it needs deterministic exact-SKE validation or an authoritative Luna review receipt`);
        if (exact) {
          record.lifecycle = 'current'; record.supportState = 'supported'; record.validation = 'source-checked'; record.origin = 'source-assertion';
        } else if (modelReviewed) {
          record.lifecycle = 'current'; record.supportState = 'supported'; record.origin = 'source-assertion';
        } else {
          record.lifecycle = 'staged'; record.supportState = 'unresolved'; record.validation = 'unreviewed-source-interpretation';
        }
      }
    }
    if (record.procedureId !== undefined || record.procedureVersion !== undefined) {
      const rule = [...(snapshot.rules ?? []), ...(snapshot.records ?? [])].find(r => r.id === record.procedureId && String(r.version ?? '1') === String(record.procedureVersion ?? '1') && Array.isArray(r.premises) && r.conclusion && isActive(r));
      if (!record.procedureId || !record.procedureVersion || (!procByVersion.has(`${record.procedureId}@${record.procedureVersion}`) && !rule)) fail(`record ${record.id} refers to an unpinned procedure or rule version`);
    }
    if (record.dependencies !== undefined && (!Array.isArray(record.dependencies) || record.dependencies.some(id => typeof id !== 'string'))) fail(`record ${record.id} dependencies must be an ID list`);
    if (!record.dependencies?.length && !(record.sourceVersionId || record.sourceId)) fail(`record ${record.id} needs source provenance or derived dependencies`);
    if (!(record.sourceVersionId || record.sourceId) && record.ske !== undefined && record.dependencies?.length) {
      if (record.transformation !== 'rule-replay' || !Array.isArray(record.premiseIds) || !record.premiseIds.length) fail(`derived SKE record ${record.id} requires explicit rule-replay premises`);
      const rule = [...(snapshot.rules ?? []), ...(snapshot.records ?? [])].find(r => r.id === record.procedureId && String(r.version ?? '1') === String(record.procedureVersion ?? '1') && Array.isArray(r.premises) && r.conclusion);
      if (!rule) fail(`derived SKE record ${record.id} has no exact pinned rule to replay`);
      const premises = record.premiseIds.map(id => stagedRecords.get(id) ?? pinnedRecords.get(id));
      if (premises.some(p => !p || !isActive(p))) fail(`derived SKE record ${record.id} has missing or stale premises`);
      if (record.premiseIds.some(id => !record.dependencies.includes(id))) fail(`derived SKE record ${record.id} dependencies omit a cited premise`);
      if (record.supportState === 'supported' && premises.some(p => p.supportState !== 'supported' || !['source-checked','model-reviewed','human-approved','rule-replayed','semantically-reviewed','valid','trusted','entity-reconciled'].includes(p.validation))) fail(`derived SKE record ${record.id} relies on premises without validated support`);
      const replay = reason(premises, [rule], { maxIterations: 1 });
      const target = typeof record.ske === 'string' ? printSKE(parseSKE(record.ske)) : printSKE(record.ske);
      const scopeKeys = ['attribution','time','modality','polarity','world'];
      const scopeMatches = d => scopeKeys.every(key => (record[key] ?? record.qualifiers?.[key] ?? (key === 'modality' ? 'asserted' : key === 'polarity' ? 'positive' : null)) === (d.scope?.[key] ?? (key === 'modality' ? 'asserted' : key === 'polarity' ? 'positive' : null)));
      const matches = replay.derivations.some(d => printSKE(d.ske) === target && d.premiseIds.length === record.premiseIds.length && d.premiseIds.every((id, i) => id === record.premiseIds[i]) && scopeMatches(d));
      if (!matches) fail(`derived SKE record ${record.id} does not follow from the pinned rule and cited premises`);
      if (record.supportState !== 'supported') { record.lifecycle = 'staged'; record.supportState = 'unresolved'; record.validation = 'unreviewed-derivation'; }
    }
    if (record.type === 'procedure-finding') {
      const receipt = receiptsById.get(record.id);
      const premiseIds = [...new Set([...(record.evidenceIds ?? []), ...(record.counterevidenceIds ?? [])])];
      if (!record.procedureId || !record.procedureVersion || !procByVersion.has(`${record.procedureId}@${record.procedureVersion}`)) fail(`procedure finding ${record.id} must name the exact pinned procedure version`);
      if(record.sourceSnapshotId!==snapshot.id) fail(`procedure finding ${record.id} was not reviewed against this exact snapshot`);
      if (!premiseIds.length || premiseIds.some(id => !(record.dependencies ?? []).includes(id))) fail(`procedure finding ${record.id} dependencies must include every cited and counterevidence record`);
      if (record.supportState === 'supported') fail(`procedure finding ${record.id} cannot claim expert or factual support`);
      if (record.validation !== 'model-reviewed' || !receipt || receipt.type !== 'procedure-review' || receipt.model !== 'gpt-6-luna' || receipt.decision !== 'reviewed'
        || receipt.procedureId !== record.procedureId || String(receipt.procedureVersion) !== String(record.procedureVersion)
        || receipt.fingerprint !== procedureReviewFingerprint(record) || record.review?.sessionId !== receipt.sessionId || record.review?.model !== receipt.model) fail(`procedure finding ${record.id} lacks an authoritative Luna review receipt`);
    }
    if (record.type === 'contextual-finding') {
      const receipt = receiptsById.get(record.id);
      if (record.supportState === 'supported') fail(`contextual finding ${record.id} is an unresolved model synthesis, not a strict factual assertion`);
      if (record.validation !== 'model-reviewed' || !receipt || receipt.type !== 'context-review' || receipt.model !== 'gpt-6-luna' || receipt.decision !== 'reviewed'
        || receipt.fingerprint !== contextReviewFingerprint(record) || record.review?.sessionId !== receipt.sessionId || record.review?.model !== receipt.model) fail(`contextual finding ${record.id} lacks an authoritative Luna context-pass receipt`);
    }
    if (!record.sourceVersionId && !record.sourceId && !['procedure-finding','contextual-finding','rule-finding'].includes(record.type)) fail(`derived record ${record.id} uses an unsupported type`);
    stagedRecords.set(record.id, record);
  }

  // Validate each source item in the evidence graph and recursively verify derived premises.
  const evidenceState = new Map();
  const visitingRecords = new Set(), validRecords = new Set();
  function visitEvidence(id) {
    if (evidenceState.get(id) === 'visiting') fail(`cyclic evidence dependency at ${id}`);
    if (evidenceState.get(id) === 'valid') return;
    const item = evidenceById.get(id);
    if (!item) fail(`missing evidence dependency ${id}`);
    evidenceState.set(id, 'visiting');
    if (item.type === 'source' || item.sourceVersionId) {
      const pair = regionByKey.get(`${item.sourceVersionId}:${item.regionId}`);
      if (!pair) fail(`evidence ${id} is outside authorized source scope or snapshot`);
      if (typeof item.quote !== 'string' || !item.quote || !pair.region.text.includes(item.quote)) fail(`evidence ${id} quote does not reopen in its source region`);
    } else if (item.type === 'derived') {
      if (!Array.isArray(item.premiseIds) || !item.premiseIds.length) fail(`derived evidence ${id} has no premises`);
      if (item.transformation !== 'rule-replay') fail(`derived evidence ${id} has an unsupported transformation`);
      for (const premiseId of item.premiseIds) visitEvidence(premiseId);
    } else if (item.type === 'procedure-finding' || item.type === 'contextual-finding') {
      const record=stagedRecords.get(id)??pinnedRecords.get(id);
      if(!record||record.type!==item.type)fail(`evidence ${id} has no matching validated ${item.type} record`);
      const same= item.type==='procedure-finding'
        ? procedureReviewFingerprint(record)===procedureReviewFingerprint(item)
        : contextReviewFingerprint(record)===contextReviewFingerprint(item);
      if(!same)fail(`evidence ${id} differs from its validated ${item.type} record`);
      const receipt=receiptsById.get(id);
      if(stagedRecords.has(id)) {
        if(item.type==='procedure-finding'&&(!receipt||receipt.type!=='procedure-review'||receipt.model!=='gpt-6-luna'||receipt.fingerprint!==procedureReviewFingerprint(record)))fail(`evidence ${id} lacks a matching procedure review receipt`);
        if(item.type==='contextual-finding'&&(!receipt||receipt.type!=='context-review'||receipt.model!=='gpt-6-luna'||receipt.fingerprint!==contextReviewFingerprint(record)))fail(`evidence ${id} lacks a matching context review receipt`);
      } else if(record.validation!=='model-reviewed'||record.review?.model!=='gpt-6-luna'||!isActive(record)) fail(`pinned finding evidence ${id} is not current model-reviewed evidence`);
      visitRecord(record);
    } else fail(`evidence ${id} has an unsupported type`);
    evidenceState.set(id, 'valid');
  }
  for (const id of evidenceById.keys()) visitEvidence(id);

  function visitRecord(record) {
    if (validRecords.has(record.id)) return;
    if (visitingRecords.has(record.id)) fail(`cyclic record dependency at ${record.id}`);
    const unresolvedProposal = record.lifecycle === 'staged' && record.supportState !== 'supported';
    if (!isActive(record) && !unresolvedProposal) fail(`record dependency ${record.id} is stale`);
    visitingRecords.add(record.id);
    if (record.sourceVersionId || record.sourceId) {
      const source = record.sourceVersionId !== undefined ? sourceByVersion.get(record.sourceVersionId) : scopedSources.find(s => s.sourceId === record.sourceId);
      if (!source) fail(`record dependency ${record.id} is outside authorized source scope`);
      const version = source.sourceVersionId ?? source.id;
      if (!record.regionId || !regionByKey.has(`${version}:${record.regionId}`)) fail(`record dependency ${record.id} has no reopenable source region`);
    }
    for (const depId of record.dependencies ?? []) {
      const dep = stagedRecords.get(depId) ?? pinnedRecords.get(depId);
      if (!dep && evidenceById.has(depId)) { visitEvidence(depId); continue; }
      if (!dep && sourceByVersion.has(depId)) continue;
      if (!dep || !isActive(dep)) fail(`record ${record.id} has missing or stale dependency ${depId}`);
      if (dep.sourceVersionId && !sourceByVersion.has(dep.sourceVersionId)) fail(`record ${record.id} depends on an out-of-scope source record ${depId}`);
      visitRecord(dep);
    }
    visitingRecords.delete(record.id); validRecords.add(record.id);
  }
  for (const record of output.records) visitRecord(record);

  const coverageIds = new Set();
  for (const item of output.coverage) {
    safeId(item?.id, 'coverage id');
    if (coverageIds.has(item.id)) fail(`duplicate coverage id ${item.id}`);
    coverageIds.add(item.id);
    if (typeof item.sourceVersionId !== 'string' || !sourceByVersion.has(item.sourceVersionId)) fail(`coverage ${item.id} is outside authorized source scope or snapshot`);
    if (typeof item.state !== 'string' || !STATES.has(item.state)) fail(`coverage ${item.id} has unsupported state`);
    if (item.regionId && !regionByKey.has(`${item.sourceVersionId}:${item.regionId}`)) fail(`coverage ${item.id} references a missing source region`);
    if(item.procedureId!==undefined){
      if(typeof item.procedureVersion!=='string'||!procByVersion.has(`${item.procedureId}@${item.procedureVersion}`))fail(`coverage ${item.id} refers to an unpinned procedure version`);
      if(!item.parameters||typeof item.parameters!=='object'||Array.isArray(item.parameters)||typeof item.parameterFingerprint!=='string')fail(`coverage ${item.id} must bind exact procedure parameters`);
      const fingerprint=createHash('sha256').update(stableStringify(item.parameters)).digest('hex');
      if(item.parameterFingerprint!==fingerprint)fail(`coverage ${item.id} has an invalid procedure parameter fingerprint`);
    }
  }
  return output;
}
