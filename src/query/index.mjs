import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { match, parseSKE, printSKE } from '../engine/index.mjs';

const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const tokenize = text => String(text ?? '').toLocaleLowerCase('en').match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [];
const STOP = new Set(['the','a','an','and','or','of','to','in','on','for','is','are','was','were','be','by','as','at','with','from','that','this','it']);
const terms = text => tokenize(text).filter(t => !STOP.has(t));
const recordExpression = r => {
  const expr = r.ske ?? r.expression ?? r.claim;
  if (!expr) return null;
  try { return typeof expr === 'string' ? parseSKE(expr) : expr; } catch { return null; }
};
function scanTerms(ast, out) {
  if (!ast) return;
  if (ast.type === 'call') { out.add(ast.predicate.toLocaleLowerCase('en')); for (const arg of ast.args) scanTerms(arg, out); }
  else if (ast.type === 'atom') out.add(ast.value.toLocaleLowerCase('en'));
  else if (ast.type === 'literal') for (const t of terms(ast.value)) out.add(t);
  else if (ast.type === 'and') for (const item of ast.terms) scanTerms(item, out);
}

function sourceEntries(snapshot) {
  return (snapshot.sources ?? []).flatMap(source => (source.regions ?? []).map(region => ({
    sourceVersionId: source.sourceVersionId ?? source.id,
    sourceId: source.sourceId,
    sourceName: source.name,
    regionId: region.id,
    quote: region.text,
    locator: region.locator,
    fidelityCaveat: region.fidelityCaveat,
    terms: terms(region.text),
    digest: source.digest
  })));
}

function structural(snapshot) {
  const predicates = new Map(), entities = new Map(), args = new Map();
  for (const record of snapshot.records ?? []) {
    if (record.lifecycle === 'stale' || !record.ske) continue;
    const ast = recordExpression(record); if (ast?.type !== 'call') continue;
    const p = ast.predicate;
    if (!predicates.has(p)) predicates.set(p, []); predicates.get(p).push(record.id);
    ast.args.forEach((arg, position) => {
      if (arg.type === 'atom') {
        if (!entities.has(arg.value)) entities.set(arg.value, []); entities.get(arg.value).push(record.id);
        const key = `${p}\0${position}\0${arg.value}`; if (!args.has(key)) args.set(key, []); args.get(key).push(record.id);
      }
      for (const alias of record.entityMentions ?? []) if (alias.entityId && alias.decision !== 'ambiguous') {
        if (!entities.has(alias.entityId)) entities.set(alias.entityId, []); entities.get(alias.entityId).push(record.id);
      }
    });
  }
  return { predicates: Object.fromEntries([...predicates].map(([k,v]) => [k,[...new Set(v)]])), entities: Object.fromEntries([...entities].map(([k,v]) => [k,[...new Set(v)]])), arguments: Object.fromEntries([...args].map(([k,v]) => [k,[...new Set(v)]])) };
}

function snapshotFingerprint(snapshot) {
  return sha({ sources: (snapshot.sources ?? []).map(s => [s.sourceVersionId ?? s.id, s.digest, s.readerProfile]), records: (snapshot.records ?? []).map(r => [r.id, r.lifecycle, r.dependencies, r.ske, r.entityMentions]) });
}
function buildIndex(snapshot) {
  const docs = sourceEntries(snapshot);
  const df = new Map();
  for (const doc of docs) for (const term of new Set(doc.terms)) df.set(term, (df.get(term) ?? 0) + 1);
  const avgdl = docs.length ? docs.reduce((n, d) => n + d.terms.length, 0) / docs.length : 0;
  return {
    version: 1, snapshotId: snapshot.id,
    fingerprint: snapshotFingerprint(snapshot),
    documents: docs.map(d => ({ ...d, length: d.terms.length, frequencies: Object.fromEntries([...d.terms.reduce((m,t) => m.set(t, (m.get(t) ?? 0) + 1), new Map())]) })),
    documentFrequency: Object.fromEntries(df), averageDocumentLength: avgdl,
    structural: structural(snapshot),
    builtAt: new Date().toISOString()
  };
}

export async function buildSnapshotIndex({ snapshot, rootDir = path.resolve('.skr-index') } = {}) {
  if (!snapshot?.id) throw new TypeError('A pinned snapshot is required');
  const index = buildIndex(snapshot); const dir = path.join(rootDir, 'snapshots'); await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${snapshot.id}.json`), temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(index), { mode: 0o600 }); await rename(temp, file);
  return { snapshotId: snapshot.id, path: file, fingerprint: index.fingerprint, documents: index.documents.length };
}

async function readIndex(snapshot, rootDir) {
  const fingerprint = snapshotFingerprint(snapshot);
  if (rootDir) {
    const file = path.join(rootDir, 'snapshots', `${snapshot.id}.json`);
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      if (cached.snapshotId === snapshot.id && cached.fingerprint === fingerprint) return cached;
    } catch { }
    await buildSnapshotIndex({ snapshot, rootDir });
    return JSON.parse(await readFile(file, 'utf8'));
  }
  return buildIndex(snapshot);
}

/** Source-scoped lexical BM25 retrieval. Scope is applied before term scoring. */
export async function searchSources({ snapshot, query, sourceScope, topK = 10, rootDir } = {}) {
  if (!snapshot?.id || typeof query !== 'string') throw new TypeError('Pinned snapshot and query are required');
  if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw new TypeError('topK must be 1..100');
  const index = await readIndex(snapshot, rootDir);
  const allowed = sourceScope ? new Set(sourceScope) : null;
  const docs = index.documents.filter(d => !allowed || allowed.has(d.sourceVersionId) || allowed.has(d.sourceId));
  const qterms = terms(query), n = docs.length, avgdl = docs.length ? docs.reduce((sum,d) => sum + d.length, 0) / docs.length : 1;
  const scopedDf = new Map(); for (const doc of docs) for (const term of new Set(doc.terms)) scopedDf.set(term, (scopedDf.get(term) ?? 0) + 1);
  const hits = docs.map(doc => {
    let score = 0;
    for (const term of qterms) {
      const tf = doc.frequencies[term] ?? 0; if (!tf) continue;
      const df = scopedDf.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const k1 = 1.2, b = 0.75;
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.length / avgdl));
    }
    return { sourceVersionId: doc.sourceVersionId, regionId: doc.regionId, quote: doc.quote, locator: doc.locator, sourceName: doc.sourceName, fidelityCaveat: doc.fidelityCaveat, score };
  }).filter(x => x.score > 0).sort((a,b) => b.score - a.score || a.sourceVersionId.localeCompare(b.sourceVersionId) || a.regionId.localeCompare(b.regionId)).slice(0, topK);
  return { snapshotId: snapshot.id, query, sourceScope: sourceScope ? [...sourceScope] : null, hits, method: 'lexical-bm25' };
}

/** Exact predicate/argument query against the pinned structural knowledge view. */
export async function queryKnowledge({ snapshot, goal, sourceScope, options = {}, rootDir } = {}) {
  if (!snapshot?.id) throw new TypeError('Pinned snapshot is required');
  const index = await readIndex(snapshot, rootDir);
  const ast = typeof goal === 'string' ? parseSKE(goal) : goal;
  const predicates = new Set();
  const collect = node => { if (node?.type === 'call') predicates.add(node.predicate); else if (node?.type === 'and') for (const term of node.terms) collect(term); else if (node?.type === 'find') collect(node.body); };
  collect(ast);
  const postingSets = [...predicates].map(p => new Set(index.structural.predicates[p] ?? []));
  const indexedIds = !postingSets.length ? null : new Set([...postingSets[0]].filter(id => postingSets.every(set => set.has(id))));
  const candidates = (snapshot.records ?? []).filter(r => !indexedIds || indexedIds.has(r.id));
  const result = match(ast, candidates, { ...options, sourceScope });
  const scopedSources = new Map((snapshot.sources ?? []).filter(s => !sourceScope || sourceScope.includes(s.id) || sourceScope.includes(s.sourceVersionId) || sourceScope.includes(s.sourceId)).map(s => [s.sourceVersionId ?? s.id, s]));
  const records = new Map((snapshot.records ?? []).map(r => [r.id, r]));
  const matches = result.matches.map(m => {
    const citedRecords = m.evidenceIds.map(id => records.get(id)).filter(Boolean);
    return { ...m, evidence: citedRecords.map(r => {
      const sourceVersionId = r.sourceVersionId ?? r.sourceId, source = scopedSources.get(sourceVersionId);
      const region = source?.regions?.find(x => x.id === r.regionId);
      return { id: r.id, sourceVersionId, regionId: r.regionId, quote: region?.text ?? r.quote, locator: region?.locator, ske: r.ske, qualifiers: { attribution: r.attribution, time: r.time, modality: r.modality, polarity: r.polarity } };
    }) };
  });
  return { ...result, snapshotId: snapshot.id, matches };
}

export async function openSourceRegion({ snapshot, sourceVersionId, regionId, sourceScope } = {}) {
  const allowed = (snapshot?.sources ?? []).find(s => (s.id === sourceVersionId || s.sourceVersionId === sourceVersionId) && (!sourceScope || sourceScope.includes(s.id) || sourceScope.includes(s.sourceVersionId) || sourceScope.includes(s.sourceId)));
  if (!allowed) throw new Error('Source is outside the selected pinned scope');
  const region = (allowed.regions ?? []).find(r => r.id === regionId);
  if (!region) throw new Error('Region is not present in the pinned source version');
  return { snapshotId: snapshot.id, sourceVersionId: allowed.sourceVersionId ?? allowed.id, regionId, quote: region.text, locator: region.locator, fidelityCaveat: region.fidelityCaveat };
}

export const structuralKey = expr => printSKE(typeof expr === 'string' ? parseSKE(expr) : expr);
