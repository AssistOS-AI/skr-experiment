import { createHash } from 'node:crypto';
import { parseSKE, printSKE } from '../engine/index.mjs';

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function reviewFingerprint(record) {
  const ske = typeof record.ske === 'string' ? printSKE(parseSKE(record.ske)) : printSKE(record.ske);
  const payload = {
    sourceVersionId: record.sourceVersionId,
    sourceId: record.sourceId ?? null,
    regionId: record.regionId,
    quote: record.quote,
    ske,
    // Hash both structured and flattened fields so a conflicting top-level scope cannot hide under `qualifiers`.
    qualifiers: record.qualifiers ?? {},
    scope: Object.fromEntries(['attribution','time','modality','polarity','world'].map(k => [k, record[k] ?? null])),
    entityMentions: record.entityMentions ?? [],
    counterevidence: record.counterevidence ?? []
  };
  return createHash('sha256').update(stable(payload)).digest('hex');
}

export function procedureReviewFingerprint(record) {
  return createHash('sha256').update(stable({ procedureId: record.procedureId, procedureVersion: record.procedureVersion, parameters: record.parameters ?? {},
    summary: record.summary, evidenceIds: record.evidenceIds ?? [], counterevidenceIds: record.counterevidenceIds ?? [], dependencies: record.dependencies ?? [], sourceSnapshotId: record.sourceSnapshotId ?? null, score: record.score ?? null, criterion: record.criterion ?? null })).digest('hex');
}

export function makeProcedureReviewReceipt(record, { sessionId, model = 'gpt-6-luna', reviewedAt = new Date().toISOString() } = {}) {
  if (!sessionId) throw new TypeError('A completed Luna procedure review is required');
  return { type: 'procedure-review', recordId: record.id, procedureId: record.procedureId, procedureVersion: record.procedureVersion,
    fingerprint: procedureReviewFingerprint(record), sessionId, model, reviewedAt, decision: 'reviewed' };
}

export function contextReviewFingerprint(record) {
  return createHash('sha256').update(stable({ relationship: record.relationship, summary: record.summary, premiseIds: record.premiseIds ?? [], counterevidenceIds: record.counterevidenceIds ?? [], sourceSnapshotId: record.sourceSnapshotId })).digest('hex');
}

export function makeContextReviewReceipt(record, { sessionId, model = 'gpt-6-luna', reviewedAt = new Date().toISOString() } = {}) {
  if (!sessionId) throw new TypeError('A completed Luna context pass is required');
  return { type: 'context-review', recordId: record.id, fingerprint: contextReviewFingerprint(record), sessionId, model, reviewedAt, decision: 'reviewed' };
}

export function makeReviewReceipt(record, { sessionId, model = 'gpt-6-luna', reviewedAt = new Date().toISOString(), decision = 'entailed' } = {}) {
  if (!sessionId || decision !== 'entailed') throw new TypeError('A completed Luna entailment review is required');
  return { recordId: record.id, sourceVersionId: record.sourceVersionId, regionId: record.regionId, fingerprint: reviewFingerprint(record), sessionId, model, reviewedAt, decision };
}
