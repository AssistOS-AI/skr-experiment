/** Deterministic, deliberately conservative reference semantic engine. */
import { createHash } from 'node:crypto';

export function parseSKE(text) {
  if (typeof text !== 'string') throw new TypeError('SKE input must be text');
  const tokens = text.match(/\s+|;[^\n]*|"(?:\\.|[^"\\])*"|\(|\)|[^\s()]+/g) ?? [];
  const ts = tokens.filter(t => !/^\s+$/.test(t) && !t.startsWith(';'));
  let i = 0;
  function term() {
    const t = ts[i++];
    if (t === undefined) throw new SyntaxError('Unexpected end of SKE');
    if (t === '(') {
      if (ts[i] === ')') throw new SyntaxError('Empty application');
      const head = ts[i++];
      if (!head || head === '(' || head === ')') throw new SyntaxError('Expected predicate');
      const args = [];
      while (i < ts.length && ts[i] !== ')') args.push(term());
      if (ts[i++] !== ')') throw new SyntaxError('Unclosed application');
      if (head === 'find') {
        const vars = args[0];
        if (!vars || vars.type !== 'list') throw new SyntaxError('find requires a variable list');
        return { type: 'find', variables: vars.items.map(v => { if (v.type !== 'variable') throw new SyntaxError('find bindings must be variables'); return v.name; }), body: args.length === 2 ? args[1] : { type: 'and', terms: args.slice(1) } };
      }
      if (head === 'and') return { type: 'and', terms: args };
      return { type: 'call', predicate: head, args };
    }
    if (t === ')') throw new SyntaxError('Unexpected closing parenthesis');
    if (t.startsWith('"')) return { type: 'literal', value: JSON.parse(t) };
    if (t.startsWith('?')) return { type: 'variable', name: t.slice(1) };
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(t)) return { type: 'number', value: Number(t) };
    return { type: 'atom', value: t };
  }
  // find's binder list is syntax, not a predicate application.
  function parseTerm() {
    if (ts[i] === '(' && ts[i + 1] === 'find' && ts[i + 2] === '(') {
      i += 3; const items = [];
      while (i < ts.length && ts[i] !== ')') items.push(term());
      if (ts[i++] !== ')') throw new SyntaxError('Unclosed find variable list');
      const vars = { type: 'list', items };
      const body = term();
      if (ts[i++] !== ')') throw new SyntaxError('Unclosed find');
      return { type: 'find', variables: vars.items.map(v => { if (v.type !== 'variable') throw new SyntaxError('find bindings must be variables'); return v.name; }), body };
    }
    return term();
  }
  const ast = parseTerm();
  if (i !== ts.length) throw new SyntaxError(`Unexpected token ${ts[i]}`);
  return ast;
}

export function printSKE(ast) {
  if (!ast || typeof ast !== 'object') throw new TypeError('Invalid SKE AST');
  switch (ast.type) {
    case 'atom': return ast.value;
    case 'literal': return JSON.stringify(ast.value);
    case 'number': return String(ast.value);
    case 'variable': return `?${ast.name}`;
    case 'call': return `(${ast.predicate}${ast.args.length ? ` ${ast.args.map(printSKE).join(' ')}` : ''})`;
    case 'and': return `(and ${ast.terms.map(printSKE).join(' ')})`;
    case 'find': return `(find (${ast.variables.map(v => `?${v}`).join(' ')}) ${printSKE(ast.body)})`;
    default: throw new TypeError(`Unknown SKE node ${ast.type}`);
  }
}

const isVar = x => x?.type === 'variable';
const key = x => x && typeof x === 'object' ? JSON.stringify(x) : String(x);
function deref(x, b) { const seen = new Set(); while (isVar(x) && b.has(x.name) && !seen.has(x.name)) { seen.add(x.name); const next = b.get(x.name); if (isVar(next) && next.name === x.name) break; x = next; } return x; }
function occurs(name, value, b) { value = deref(value, b); if (isVar(value)) return value.name === name; if (value?.type === 'call') return value.args.some(x => occurs(name, x, b)); return false; }
function unify(a, c, bindings = new Map()) {
  a = deref(a, bindings); c = deref(c, bindings);
  if (isVar(a) && isVar(c) && a.name === c.name) return bindings;
  if (isVar(a)) { if (occurs(a.name, c, bindings)) return null; bindings.set(a.name, c); return bindings; }
  if (isVar(c)) { if (occurs(c.name, a, bindings)) return null; bindings.set(c.name, a); return bindings; }
  if (a?.type !== c?.type) return null;
  if (a.type === 'call') {
    if (a.predicate !== c.predicate || a.args.length !== c.args.length) return null;
    for (let i = 0; i < a.args.length; i++) if (!unify(a.args[i], c.args[i], bindings)) return null;
    return bindings;
  }
  return key(a) === key(c) ? bindings : null;
}
function materialize(x, b) {
  x = deref(x, b);
  if (isVar(x)) return x;
  if (x?.type === 'call') return { ...x, args: x.args.map(a => materialize(a, b)) };
  return x;
}
const plainBindings = b => Object.fromEntries([...b].map(([k, v]) => [k, materialize(v, b)]));
const scopeOf = r => { const q=r.qualifiers??{}; return { attribution:r.attribution??q.attribution??null, time:r.time??q.time??null, modality:r.modality??q.modality??'asserted', polarity:r.polarity??q.polarity??'positive', world:r.world??q.world??null }; };
const stableValue = value => Array.isArray(value) ? `[${value.map(stableValue).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableValue(value[k])}`).join(',')}}` : JSON.stringify(value);
function sourceReviewFingerprint(record) {
  const ske=typeof record.ske==='string'?printSKE(parseSKE(record.ske)):printSKE(record.ske);
  const payload={sourceVersionId:record.sourceVersionId,sourceId:record.sourceId??null,regionId:record.regionId,quote:record.quote,ske,qualifiers:record.qualifiers??{},scope:Object.fromEntries(['attribution','time','modality','polarity','world'].map(k=>[k,record[k]??null])),entityMentions:record.entityMentions??[],counterevidence:record.counterevidence??[]};
  return createHash('sha256').update(stableValue(payload)).digest('hex');
}
const sameScope = (a, b) => JSON.stringify(scopeOf(a)) === JSON.stringify(scopeOf(b));
const sameClaimScope = (a, b) => { const left=scopeOf(a), right=scopeOf(b); return ['attribution','time','modality','world'].every(k => left[k] === right[k]); };
const usable = r => !['stale','retracted','superseded','staged'].includes(r.lifecycle) && (r.supportState == null || r.supportState === 'supported') && (r.validation == null || ['valid','trusted','structurally-valid','source-checked','rule-replayed','semantically-reviewed','model-reviewed','human-approved'].includes(r.validation) || (r.validation==='entity-reconciled'&&r.lifecycle==='current'&&Boolean(r.entityReconciliation?.operationId)&&Boolean(r.entityReconciliation?.fromEntityId)&&Boolean(r.entityReconciliation?.toEntityId))) && !['hypothesis','candidate-extraction','unreviewed'].includes(r.origin);
function expressionOf(r) {
  let e = r.ske ?? r.expression ?? r.claim;
  if (typeof e === 'string') { try { e = parseSKE(e); } catch { return null; } }
  return e?.type === 'call' ? e : null;
}
function recordsOf(input) { return Array.isArray(input) ? input : input?.records ?? []; }

/** Structural matches only. We never infer entailment from lexical similarity. */
export function match(goal, records, options = {}) {
  if (typeof goal === 'string') goal = parseSKE(goal);
  if (goal?.type === 'find') return resolveFind(goal, recordsOf(records), options);
  const sourceScope = options.sourceScope;
  const out = [];
  for (const record of recordsOf(records)) {
    if (!usable(record)) continue;
    if (sourceScope && !sourceScope.includes(record.sourceVersionId) && !sourceScope.includes(record.sourceId) && !sourceScope.includes(record.id)) continue;
    const expr = expressionOf(record); if (!expr) continue;
    const b = unify(goal, expr); if (!b) continue;
    const requestedScope = options.scope;
    const state=scopeOf(record), scopeAligned = !requestedScope || ['attribution','time','modality','polarity','world'].every(k => requestedScope[k] == null || requestedScope[k] === state[k]);
    const qualified = (state.modality !== 'asserted' && requestedScope?.modality !== state.modality) || (state.attribution != null && requestedScope?.attribution !== state.attribution) || (state.time != null && requestedScope?.time !== state.time) || (state.world != null && requestedScope?.world !== state.world) || (state.polarity === 'negative' && requestedScope?.polarity !== 'negative');
    const opposite = recordsOf(records).find(other => { const otherScope=scopeOf(other); return other.id !== record.id && usable(other) && (!sourceScope || sourceScope.includes(other.sourceVersionId) || sourceScope.includes(other.sourceId) || sourceScope.includes(other.id)) && key(expressionOf(other)) === key(expr) && otherScope.polarity !== state.polarity && sameClaimScope(record,other); });
    const equivalent = scopeAligned && !qualified;
    out.push({ relation: opposite ? 'contested' : equivalent ? 'equivalent' : 'ambiguous', bindings: plainBindings(b), recordId: record.id, evidenceIds: opposite ? [record.id,opposite.id] : [record.id], scope: scopeOf(record), assumptions: opposite ? ['opposing assertion exists at the same recorded scope'] : equivalent ? [] : ['time, modality, polarity, or attribution scope requires explicit alignment'], residuals: [], validation: 'structural-match' });
  }
  return { matches: out, bindings: out.map(x => x.bindings), residuals: out.length ? [] : [{ goal, reason: 'no exact structural assertion found' }], coverage: { recordsConsidered: recordsOf(records).length } };
}
function flattenGoals(body) { return body?.type === 'and' ? body.terms : [body]; }
function resolveFind(query, records, options) {
  let rows = [{ bindings: new Map(), evidenceIds: [], scopes: [] }];
  for (const goal of flattenGoals(query.body)) {
    const next = [];
    for (const row of rows) for (const rec of records) {
      if (!usable(rec)) continue;
      if (options.sourceScope && !options.sourceScope.includes(rec.sourceVersionId) && !options.sourceScope.includes(rec.sourceId) && !options.sourceScope.includes(rec.id)) continue;
      const expr = expressionOf(rec); if (!expr) continue;
      const b = unify(goal, expr, new Map(row.bindings));
      const compatible = !row.scopes.length || JSON.stringify(row.scopes[0]) === JSON.stringify(scopeOf(rec));
      if (b && compatible) next.push({ bindings: b, evidenceIds: [...row.evidenceIds, rec.id], scopes: [...row.scopes, scopeOf(rec)] });
    }
    rows = next;
  }
  return { matches: rows.map(r => {
    const all = plainBindings(r.bindings), bindings = Object.fromEntries(query.variables.filter(v => v in all).map(v => [v,all[v]]));
    const evidenceIds = new Set(r.evidenceIds);
    let contested = false;
    for (const id of r.evidenceIds) {
      const premise = records.find(x => x.id === id); if (!premise || !usable(premise)) continue;
      const premiseExpr = expressionOf(premise);
      const opposite = records.find(other => other.id !== id && usable(other) && (!options.sourceScope || options.sourceScope.includes(other.sourceVersionId) || options.sourceScope.includes(other.sourceId) || options.sourceScope.includes(other.id)) && key(expressionOf(other)) === key(premiseExpr) && (other.polarity ?? 'positive') !== (premise.polarity ?? 'positive') && sameClaimScope(premise,other));
      if (opposite) { contested = true; evidenceIds.add(opposite.id); }
    }
    const aligned = !options.scope || r.scopes.every(s => ['attribution','time','modality','polarity','world'].every(k => options.scope[k] == null || options.scope[k] === s[k]));
    const qualified = r.scopes.some(s => (s.time && options.scope?.time !== s.time) || (s.attribution && options.scope?.attribution !== s.attribution) || (s.world && options.scope?.world !== s.world) || (s.polarity === 'negative' && options.scope?.polarity !== 'negative') || (s.modality !== 'asserted' && options.scope?.modality !== s.modality));
    return { relation: contested ? 'contested' : qualified || !aligned ? 'ambiguous' : 'equivalent', bindings, evidenceIds: [...evidenceIds], scope: r.scopes, assumptions: contested ? ['opposing assertion exists at the same recorded scope'] : qualified || !aligned ? ['time, modality, polarity, or attribution scope retained'] : [], residuals: [], validation: 'structural-join' };
  }), bindings: rows.map(r => { const all=plainBindings(r.bindings); return Object.fromEntries(query.variables.filter(v => v in all).map(v => [v,all[v]])); }), residuals: rows.length ? [] : flattenGoals(query.body).map(goal => ({ goal, reason: 'join has no complete binding' })), coverage: { recordsConsidered: records.length } };
}

const varsIn = (x, out = new Set()) => { if (isVar(x)) out.add(x.name); else if (x?.type === 'call') x.args.forEach(y => varsIn(y, out)); else if (x?.type === 'and') x.terms.forEach(y => varsIn(y, out)); return out; };
function substitute(x, b) { if (isVar(x)) return b.get(x.name) ?? x; if (x?.type === 'call') return { ...x, args: x.args.map(y => substitute(y, b)) }; return x; }
export function reason(records, rules, options = {}) {
  const facts = recordsOf(records).filter(r => expressionOf(r) && usable(r)).map(r => ({ ...r, ske: expressionOf(r), dependencies: r.dependencies ?? [r.id], lifecycle: r.lifecycle ?? 'current', scope: scopeOf(r), origin: r.origin ?? 'source-assertion' }));
  const ruleInput = rules === undefined ? recordsOf(records).filter(r => Array.isArray(r.premises) && r.conclusion) : rules;
  const ruleList = ruleInput.filter(r => usable(r)).map(r => ({ ...r, premises: r.premises.map(p => typeof p === 'string' ? parseSKE(p) : p), conclusion: typeof r.conclusion === 'string' ? parseSKE(r.conclusion) : r.conclusion }));
  const limit = Math.max(1, Math.min(options.maxIterations ?? 20, 100));
  const maxFacts = Math.max(1, Math.min(options.maxFacts ?? 1000, 10000));
  let changed = true, iteration = 0;
  while (changed && iteration++ < limit && facts.length < maxFacts) {
    changed = false;
    for (const rule of ruleList) {
      if (!Array.isArray(rule.premises) || !rule.premises.length || !rule.conclusion) continue;
      const allVars = new Set(varsIn(rule.conclusion)); rule.premises.forEach(p => varsIn(p, allVars));
      const premiseVars = new Set(); rule.premises.forEach(p => varsIn(p, premiseVars));
      if ([...varsIn(rule.conclusion)].some(v => !premiseVars.has(v))) continue;
      let rows = [{ b: new Map(), premises: [] }];
      for (const p of rule.premises) {
        const next = [];
        for (const row of rows) for (const fact of facts) {
          const b = unify(p, fact.ske, new Map(row.b));
          if (b && (row.premises.length === 0 || sameScope(row.premises[0], fact))) next.push({ b, premises: [...row.premises, fact] });
        }
        rows = next; if (!rows.length) break;
      }
      for (const row of rows) {
        const conclusion = substitute(rule.conclusion, row.b); if ([...varsIn(conclusion)].length) continue;
        if (facts.some(f => key(f.ske) === key(conclusion) && JSON.stringify(f.scope) === JSON.stringify(row.premises[0].scope))) continue;
        const premises = [...new Set(row.premises.flatMap(p => p.dependencies ?? [p.id]))];
        const derived = { id: `derived_${String(rule.id).replace(/[^A-Za-z0-9_-]/g,'_')}_${facts.length + 1}`, ske: conclusion, dependencies: premises, sourceSnapshotId: row.premises[0].sourceSnapshotId, procedureId: rule.id, procedureVersion: rule.version ?? '1', lifecycle: 'current', ...row.premises[0].scope, scope: row.premises[0].scope, origin: 'explicit-derivation', transformation: 'rule-replay', premiseIds: row.premises.map(p => p.id) };
        facts.push(derived); changed = true; if (facts.length >= maxFacts) break;
      }
    }
  }
  return { records: facts, derivations: facts.filter(f => f.origin === 'explicit-derivation'), iterations: iteration, complete: !changed, residuals: changed ? [{ reason: 'fixpoint bound reached' }] : [] };
}

function normalizeQuestion(question) { return String(question ?? '').trim(); }
export function resolve({ question, goal, snapshot = {}, sourceScope, scope, procedures = [], policy = {} } = {}) {
  const allRecords = recordsOf(snapshot);
  const authorizedIds = new Set();
  if (sourceScope) {
    for (const r of allRecords) if (!r.dependencies?.length && r.origin !== 'explicit-derivation' && (sourceScope.includes(r.sourceVersionId) || sourceScope.includes(r.sourceId) || sourceScope.includes(r.id))) authorizedIds.add(r.id);
    let grew = true;
    while (grew) { grew = false; for (const r of allRecords) if (!authorizedIds.has(r.id) && r.dependencies?.length && r.dependencies.every(d => authorizedIds.has(d))) { authorizedIds.add(r.id); grew = true; } }
  }
  const records = allRecords.filter(r => !['stale','retracted','superseded'].includes(r.lifecycle) && (!sourceScope || authorizedIds.has(r.id) || sourceScope.includes(r.sourceVersionId) || sourceScope.includes(r.sourceId)));
  let parsedGoal = goal;
  if (typeof parsedGoal === 'string') parsedGoal = parseSKE(parsedGoal);
  const parsedQuestion = normalizeQuestion(question);
  if (!parsedGoal) {
    const m = parsedQuestion.match(/^\s*\(?\w+[\w:-]*(?:\s|\))/);
    if (m) { try { parsedGoal = parseSKE(parsedQuestion); } catch {} }
  }
  const closure = reason(records, snapshot.rules ?? records.filter(r => r.type === 'rule'), policy.reasoning ?? {});
  const result = parsedGoal ? match(parsedGoal, closure.records, { scope }) : { matches: [], residuals: [{ reason: 'natural-language interpretation requires configured coding-agent runner' }], coverage: { recordsConsidered: records.length } };
  const matches = result.matches ?? [];
  const claims = matches.map(m => ({ text: parsedGoal?.type === 'find' ? JSON.stringify(m.bindings) : (parsedGoal ? printSKE(parsedGoal) : parsedQuestion), goal: parsedGoal ?? null, queryScope: scope ?? null, bindings: m.bindings ?? {}, evidenceIds: m.evidenceIds ?? [], supportState: m.relation === 'equivalent' ? 'supported' : m.relation === 'contested' ? 'contested' : 'unresolved' }));
  const evidence = [];
  const addEvidence = id => {
    if (evidence.some(e => e.id === id)) return;
    const r = closure.records.find(x => x.id === id); if (!r) return;
    evidence.push(evidenceFor(r, snapshot));
    if (r.premiseIds) r.premiseIds.forEach(addEvidence);
  };
  matches.forEach(m => (m.evidenceIds ?? []).forEach(addEvidence));
  if (!parsedGoal) {
    const candidates = (snapshot.sources ?? []).filter(s => !sourceScope || sourceScope.includes(s.id) || sourceScope.includes(s.sourceVersionId)).flatMap(s => (s.regions ?? []).map(region => ({ id: `region_${String(s.id ?? s.sourceVersionId).replace(/[^A-Za-z0-9_-]/g,'_')}_${String(region.id).replace(/[^A-Za-z0-9_-]/g,'_')}`, type: 'source', sourceVersionId: s.id ?? s.sourceVersionId, regionId: region.id, locator: region.locator ?? null, quote: region.text, semanticStatus: 'unverified-raw-passage' })));
    evidence.push(...candidates.slice(0,20));
    if (result.coverage) result.coverage.rawPassageCandidates = Math.min(candidates.length,20);
  }
  const supported = matches.some(m => m.relation === 'equivalent'), contested = matches.some(m => m.relation === 'contested');
  const answer = contested ? `Contested: ${parsedGoal ? printSKE(parsedGoal) : parsedQuestion}` : supported ? (parsedGoal?.type === 'find' ? claims.filter(c => c.supportState === 'supported').map(c => c.text).join('\n') : claims[0].text) : `Unresolved: ${parsedQuestion || 'no question supplied'}`;
  const answerPackage = { answer, claims, interpretation: parsedGoal ? 'The supplied SKE goal was matched structurally.' : 'No deterministic natural-language interpretation was attempted.', supportState: contested ? 'contested' : supported ? 'supported' : 'unresolved', coverage: result.coverage, procedureVersions: procedures.map(p => ({ id: p.id, version: p.version })), snapshotId: snapshot.id ?? null, residuals: result.residuals ?? [] };
  return { answerPackage, evidence, coverage: result.coverage ?? { recordsConsidered: records.length }, validation: { status: supported ? 'supported' : 'unresolved', deterministicReference: true } };
}
function evidenceFor(r, snapshot) {
  const original = (snapshot.sources ?? []).find(s => s.id === r.sourceVersionId || s.sourceVersionId === r.sourceVersionId);
  const region = original?.regions?.find(x => x.id === r.regionId);
  if (r.origin === 'explicit-derivation' || r.transformation) return { id: r.id, type: 'derived', premiseIds: r.premiseIds ?? r.dependencies ?? [], transformation: r.transformation ?? 'rule-replay', procedureId: r.procedureId, procedureVersion: r.procedureVersion, sourceSnapshotId: r.sourceSnapshotId, ske: r.ske, ...scopeOf(r) };
  return { id: r.id, type: 'source', sourceVersionId: r.sourceVersionId, regionId: r.regionId, locator:region?.locator??null, quote: region?.text ?? r.quote ?? null, ske: r.ske, ...scopeOf(r) };
}

/** Heuristic ledger only: source text is never silently promoted to semantic facts. */
export function ingestSource(source, { snapshot = {}, sourceScope } = {}) {
  const sources = source ? [source] : snapshot.sources ?? [];
  const coverage = [], assertions = [];
  for (const s of sources) for (const region of s.regions ?? []) {
    const included = !sourceScope || sourceScope.includes(s.id) || sourceScope.includes(s.sourceVersionId);
    coverage.push({ sourceVersionId: s.id ?? s.sourceVersionId, regionId: region.id, locator: region.locator, state: included ? 'deferred' : 'intentionally-excluded', reason: included ? 'No semantic extractor configured; region retained for later inspection.' : 'Outside requested source scope.' });
    if (included) assertions.push({ id: `candidate_${String(s.id ?? s.sourceVersionId).replace(/[^A-Za-z0-9_-]/g,'_')}_${String(region.id).replace(/[^A-Za-z0-9_-]/g,'_')}`, type: 'candidate-extraction', sourceVersionId: s.id ?? s.sourceVersionId, regionId: region.id, quote: region.text, lifecycle: 'staged', validation: 'unreviewed', supportState: 'unresolved' });
  }
  return { ledger: coverage, coverage, assertions, records: [], changeSet: { coverage }, validation: { status: 'deferred', semanticExtraction: false } };
}

const PROCEDURES = {
  'contradiction-audit': { id:'contradiction-audit', version: '1.0.0', purpose: 'Audit opposed assertions while distinguishing a contradiction within one complete epistemic scope from a revision, changed world, or attributed disagreement.', applicableInputs:['complete-work source passages','scoped assertions'], parameters:{scopeKeys:['attribution','time','modality','world'],polarityKey:'polarity',includeRevisionPairs:true}, orderedSteps:['group structurally identical claims without reversing roles','compare polarity','compare attribution,time,modality,world independently','classify equal-scope opposition as potential contradiction','retain differing-scope opposition as a revision or perspective pair'], evidenceObligations:['cite both sides','preserve every scope field','never merge possible with observed or attributed speech with narrator fact'], outputSchema:'procedure-finding[]', materializationPolicy:'explicit-only', watchScope:['assertions','source-scope'], type: 'contradiction' },
  'relevance-synthesis': { id:'relevance-synthesis', version: '1.0.0', purpose: 'Answer a pinned question or topic by selecting relevant evidence across the complete authorized source, tracking requested answer elements and avoiding redundant passages.', applicableInputs:['question or topic','optional predicate-first SKE goal','complete-work source passages','scoped assertions'], parameters:{question:'string',topic:'string',goal:'SKE call',minimumCoverage:0.0,maximumRedundancy:0.25,redundancyPolicy:'deduplicate-with-citations'}, orderedSteps:['interpret question/topic conservatively','identify requested subquestions or answer elements','select direct and necessary contextual evidence','deduplicate repeated evidence while retaining all source locations','report coverage, gaps and unresolved elements'], evidenceObligations:['cite every answer element','measure requested-element coverage','include residuals for unsupported elements','preserve contradicting evidence'], outputSchema:'procedure-finding[]', materializationPolicy:'explicit-only', watchScope:['assertions','question','topic','source-scope'], type: 'relevance' },
  'document-literary-rubric': { id:'document-literary-rubric', version: '1.0.0', purpose: 'Produce explicitly provisional, passage-grounded literary observations across a complete work using supplied criteria, positive and negative anchors, and counterevidence.', applicableInputs:['complete-work source passages','optional scoped assertions','criteria'], parameters:{criteria:[{id:'narrative-coherence',name:'Narrative coherence',description:'How events and transitions form an intelligible narrative.',positiveAnchors:['explicit setup and payoff','consistent event sequence'],negativeAnchors:['unresolved discontinuity','contradictory event order']},{id:'characterization',name:'Characterization',description:'How actions, speech and change establish characters.',positiveAnchors:['repeated behavior or explicit change','distinctive speech/action'],negativeAnchors:['unsupported motive attribution','contradictory characterization']},{id:'style',name:'Style',description:'Observable language, imagery, voice and formal choices.',positiveAnchors:['recurrent image or diction','specific sentence-level technique'],negativeAnchors:['claim based only on generic praise','counterexample to claimed pattern']},{id:'thematic-development',name:'Thematic development',description:'How a theme is introduced, varied and developed across the work.',positiveAnchors:['multiple separated passages show development','explicit thematic contrast'],negativeAnchors:['single-passage generalization','counterexample undermines pattern']}],confidenceScale:[0,1],requireCounterevidence:true}, orderedSteps:['consider the entire selected work, not only opening passages','apply every supplied criterion and quote named textual anchors','separate observation from interpretation','record counterevidence or state where searched coverage is incomplete','mark judgments provisional and unresolved pending expert review'], evidenceObligations:['cite passage-level positive anchors','cite counterexamples separately','report complete-work coverage and uncovered regions','never label model interpretation as expert or human judgment'], outputSchema:'procedure-finding[]', materializationPolicy:'explicit-only', watchScope:['source-content','assertions','rubric'], type: 'rubric' }
};
export function builtinProcedures() { return structuredClone(Object.values(PROCEDURES)); }
export function applyProcedure({ procedure, snapshot = {}, parameters = {}, sourceScope } = {}) {
  const id = typeof procedure === 'string' ? procedure : procedure?.id;
  const base = PROCEDURES[id];
  const def = base ? { ...base, ...(typeof procedure === 'object' ? procedure : {}), id, type: base.type } : (typeof procedure === 'object' ? procedure : null);
  if (!def) return { findings: [], evidence: [], coverage: { recordsConsidered: 0 }, changeSet: { records: [] }, validation: { status: 'unsupported-procedure', error: `Unknown procedure ${id}` } };
  const records = recordsOf(snapshot).filter(r => expressionOf(r) && r.lifecycle !== 'stale' && (!sourceScope || sourceScope.includes(r.sourceVersionId) || sourceScope.includes(r.sourceId)));
  let findings = [];
  if (id === 'contradiction-audit' || def.type === 'contradiction') {
    for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
      const a = records[i], b = records[j];
      const negativePair = (a.polarity ?? 'positive') !== (b.polarity ?? 'positive');
      const ascope=scopeOf(a),bscope=scopeOf(b),scopeDiff=['attribution','time','modality','world'].some(k=>ascope[k]!==bscope[k]);
      const temporalDiff = scopeDiff;
      if (negativePair && key(expressionOf(a)) === key(expressionOf(b))) findings.push(makeFinding(def, parameters, [a,b], temporalDiff ? 'scope_difference' : 'potential_contradiction', temporalDiff ? 'Conflicting polarity is reported with differing attribution or time; this may be revision or perspective.' : 'Opposite polarity on structurally identical claims in aligned recorded scope.'));
    }
  } else if (id === 'relevance-synthesis' || def.type === 'relevance') {
    let goal = parameters.goal; if (typeof goal === 'string') try { goal = parseSKE(goal); } catch { goal = null; }
    if (goal) for (const r of records) if (unify(goal, expressionOf(r))) findings.push(makeFinding(def, parameters, [r], 'exactly_relevant', 'Exact structural match to the supplied relevance goal.'));
  } else {
    const criteria = Array.isArray(parameters.criteria) ? parameters.criteria : [];
    for (const r of records) for (const criterion of criteria) findings.push(makeFinding(def, parameters, [r], 'evidence_for_review', `Passage retained for provisional human or configured-agent assessment against criterion ${criterion?.id??criterion}: ${criterion?.name??criterion}`));
  }
  const evidence = findings.flatMap(f => f.evidenceIds.map(id => evidenceFor(records.find(r => r.id === id), snapshot)));
  return { findings, evidence, coverage: { recordsConsidered: records.length, findings: findings.length }, changeSet: { records: findings }, validation: { status: 'heuristic-reference', expertJudgment: false, procedure: id, version: def.version ?? procedure.version } };
}
function makeFinding(def, parameters, premises, outputType, text) {
  const safe = String(`${def.id ?? def.type}_${premises.map(x => x.id).join('_')}`).replace(/[^A-Za-z0-9_-]/g,'_');
  return { id: `finding_${safe}`, type: 'procedure-finding', procedureId: def.id, procedureVersion: def.version, parameters, outputType, text, evidenceIds: premises.map(x => x.id), dependencies: premises.map(x => x.id), sourceSnapshotId: premises[0]?.sourceSnapshotId, lifecycle: 'staged', supportState: outputType === 'potential_contradiction' ? 'contested' : 'unresolved', validation: 'heuristic-reference' };
}
export function auditEvidence({ answerPackage = {}, evidence = [], snapshot = {}, sourceScope, reviewReceipts = [], ephemeralRecords = [] } = {}) {
  const byId = new Map(evidence.map(e => [e.id, e]));
  const ephemeralById=new Map(ephemeralRecords.map(r=>[r.id,r])),receiptsById=new Map(reviewReceipts.map(r=>[r.recordId,r]));
  const errors = [], checked = [], staleIds = new Set((snapshot.records ?? []).filter(r => r.lifecycle === 'stale').map(r => r.id));
  const visit = (id, seen = new Set()) => {
    if (seen.has(id)) { errors.push({ evidenceId: id, reason: 'cyclic derivation' }); return false; }
    // A source-version dependency is an invalidation pin, not an evidence row. Verify
    // that it exists in the authoritative snapshot and remains inside the requested scope.
    const pinnedSource=(snapshot.sources??[]).find(s=>(s.id??s.sourceVersionId)===id);
    if(pinnedSource){if(sourceScope&&!sourceScope.includes(id)&&!sourceScope.includes(pinnedSource.sourceId)){errors.push({evidenceId:id,reason:'source-version dependency is outside authorized scope'});return false;}checked.push(id);return true;}
    const e = byId.get(id); if (!e) { errors.push({ evidenceId: id, reason: 'missing evidence' }); return false; }
    if (staleIds.has(id)) { errors.push({ evidenceId: id, reason: 'stale evidence' }); return false; }
    if (e.type === 'source') {
      if (sourceScope && !sourceScope.includes(e.sourceVersionId)) { errors.push({ evidenceId: id, reason: 'outside authorized source scope' }); return false; }
      const s = (snapshot.sources ?? []).find(s => (s.id ?? s.sourceVersionId) === e.sourceVersionId);
      const region = s?.regions?.find(r => r.id === e.regionId);
      if (!region) { errors.push({ evidenceId: id, reason: 'source region could not be reopened' }); return false; }
      if (typeof e.quote !== 'string' || !e.quote.length || !region.text.includes(e.quote)) { errors.push({ evidenceId: id, reason: 'quote does not match reopened region' }); return false; }
      let assertion = (snapshot.records ?? []).find(r => r.id === id);
      if(!assertion&&e.ephemeral===true){const candidate=ephemeralById.get(id),receipt=receiptsById.get(id);if(candidate&&receipt&&receipt.model==='gpt-6-luna'&&receipt.decision==='entailed'&&receipt.sourceVersionId===candidate.sourceVersionId&&receipt.regionId===candidate.regionId&&receipt.fingerprint===sourceReviewFingerprint(candidate))assertion=candidate;else{errors.push({evidenceId:id,reason:'ephemeral source assertion lacks a matching independent Luna review receipt'});return false;}}
      if (!assertion && !e.ske) { checked.push(id); return true; } // Raw source quote; integrity only, never semantic support.
      if (!assertion || (assertion.sourceVersionId ?? assertion.sourceId) !== e.sourceVersionId || assertion.regionId !== e.regionId) { errors.push({ evidenceId: id, reason: 'evidence is not linked to a pinned source assertion' }); return false; }
      const stored = expressionOf(assertion);
      const cited = typeof e.ske === 'string' ? parseSKE(e.ske) : e.ske;
      if (!stored || key(stored) !== key(cited)) { errors.push({ evidenceId: id, reason: 'cited expression differs from pinned source assertion' }); return false; }
      if (JSON.stringify(scopeOf(assertion)) !== JSON.stringify(scopeOf(e))) { errors.push({ evidenceId: id, reason: 'cited scope differs from pinned source assertion' }); return false; }
      checked.push(id); return true;
    }
    if (e.type === 'derived') {
      if (!Array.isArray(e.premiseIds) || !e.premiseIds.length) { errors.push({ evidenceId: id, reason: 'derived evidence has no premises' }); return false; }
      if (e.transformation !== 'rule-replay') { errors.push({ evidenceId: id, reason: 'unsupported derivation transformation' }); return false; }
      const ok = e.premiseIds.map(pid => visit(pid, new Set([...seen,id]))).every(Boolean);
      if (e.transformation === 'rule-replay') {
        const rule = [...(snapshot.rules ?? []), ...(snapshot.records ?? [])].find(r => r.id === e.procedureId && (r.version ?? '1') === (e.procedureVersion ?? '1') && usable(r));
        if (!rule || !rule.conclusion) { errors.push({ evidenceId: id, reason: 'rule transformation cannot be replayed from pinned snapshot' }); return false; }
        const rulePremises = (rule.premises ?? []).map(p => typeof p === 'string' ? parseSKE(p) : p);
        const premiseRecords = e.premiseIds.map(pid => byId.get(pid));
        if (premiseRecords.some(p => !p) || premiseRecords.some(p => !sameScope(premiseRecords[0],p)) || !sameScope(e,premiseRecords[0])) { errors.push({ evidenceId: id, reason: 'derived premises do not preserve one compatible scope' }); return false; }
        let rows = [new Map()];
        for (const premise of rulePremises) {
          const next = [];
          for (const row of rows) for (const record of premiseRecords) {
            const expression = typeof record?.ske === 'string' ? parseSKE(record.ske) : (record?.ske ?? null);
            if (expression) { const b = unify(premise, expression, new Map(row)); if (b) next.push(b); }
          }
          rows = next;
        }
        const conclusion = typeof e.ske === 'string' ? parseSKE(e.ske) : e.ske;
        const ruleConclusion = typeof rule.conclusion === 'string' ? parseSKE(rule.conclusion) : rule.conclusion;
        if (!rows.some(b => key(substitute(ruleConclusion, b)) === key(conclusion))) { errors.push({ evidenceId: id, reason: 'rule replay does not produce the cited conclusion' }); return false; }
      }
      if (ok) checked.push(id); return ok;
    }
    if (e.type === 'procedure-finding' || e.type === 'contextual-finding') {
      const stored=(snapshot.records??[]).find(r=>r.id===id),expectedType=e.type;
      if(!stored||stored.type!==expectedType||stored.lifecycle!=='current'||stored.validation!=='model-reviewed'||stored.supportState==='supported') { errors.push({evidenceId:id,reason:'procedure/context assessment is not a current reviewed unresolved finding'});return false; }
      // Assessment prose and its numeric/criterion fields are material evidence. An ID and
      // dependency list alone do not authenticate them: compare every pinned field that can
      // change the meaning of a procedure/context finding.
      const materialFields = expectedType === 'procedure-finding'
        ? ['procedureId','procedureVersion','parameters','summary','score','criterion','evidenceIds','counterevidenceIds','dependencies','sourceSnapshotId','supportState']
        : ['relationship','summary','premiseIds','counterevidenceIds','dependencies','sourceSnapshotId','supportState'];
      const canonical = value => JSON.stringify(value === undefined ? null : value);
      const changed = materialFields.filter(field => canonical(e[field]) !== canonical(stored[field]));
      if (changed.length) { errors.push({evidenceId:id,reason:'finding content differs from pinned reviewed record',fields:changed}); return false; }
      const procedureOk=expectedType==='contextual-finding'||(snapshot.procedures??[]).some(p=>p.id===stored.procedureId&&String(p.version)===String(stored.procedureVersion)&&p.active!==false);
      if(!procedureOk){errors.push({evidenceId:id,reason:'finding references an unpinned procedure version'});return false;}
      const dependencies=stored.dependencies??[];
      if(!dependencies.length||JSON.stringify([...dependencies].sort())!==JSON.stringify([...(e.dependencies??[])].sort())){errors.push({evidenceId:id,reason:'finding dependencies differ from pinned finding'});return false;}
      const ok=dependencies.map(dep=>visit(dep,new Set([...seen,id]))).every(Boolean);
      if(ok)checked.push(id);return ok;
    }
    errors.push({ evidenceId: id, reason: 'unknown evidence type' }); return false;
  };
  const claims = answerPackage.claims ?? [];
  let unsupportedClaims = 0;
  for (const claim of claims) {
    const errorCountBefore = errors.length;
    for (const id of claim.evidenceIds ?? []) visit(id);
    if (claim.supportState === 'supported') {
      if (!claim.goal) errors.push({ reason: 'supported claim has no structured goal for semantic validation' });
      else if (!(claim.evidenceIds ?? []).length) errors.push({ reason: 'supported claim has no evidence' });
      else {
        const goal = typeof claim.goal === 'string' ? parseSKE(claim.goal) : claim.goal;
        const bindings = new Map(Object.entries(claim.bindings ?? {}));
        const cited = (claim.evidenceIds ?? []).map(id => byId.get(id)).filter(Boolean).map(e => typeof e.ske === 'string' ? parseSKE(e.ske) : e.ske).filter(Boolean);
        if (goal?.type === 'find') {
          const joined = resolveFind(goal, (claim.evidenceIds ?? []).map(id => byId.get(id)).filter(Boolean), { scope: claim.queryScope });
          const bindingKey = key(claim.bindings ?? {});
          if (!joined.matches.some(m => m.relation === 'equivalent' && key(m.bindings) === bindingKey)) errors.push({ reason: 'cited evidence does not establish one consistent shared-variable join', claim: claim.text });
        } else {
          const required = substitute(goal, bindings);
          const grounded = match(required, (claim.evidenceIds ?? []).map(id => byId.get(id)).filter(Boolean), { scope: claim.queryScope });
          if (!grounded.matches.some(m => m.relation === 'equivalent')) errors.push({ reason: 'cited assertions do not support the claim at the requested attribution, time, modality, polarity, and world scope', claim: claim.text });
        }
      }
    }
    if (claim.supportState === 'supported' && errors.length > errorCountBefore) unsupportedClaims++;
  }
  const valid = errors.length === 0 && (answerPackage.supportState !== 'supported' || claims.some(c => c.supportState === 'supported'));
  return { status: valid ? 'valid' : 'invalid', checkedEvidenceIds: [...new Set(checked)], errors, claimCount: (answerPackage.claims ?? []).length, unsupportedClaims };
}

export const procedureDefinitions = () => structuredClone(PROCEDURES);
