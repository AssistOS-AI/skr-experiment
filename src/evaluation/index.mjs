import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve as runResolve, parseSKE, printSKE, auditEvidence } from '../engine/index.mjs';

export const BASELINES = {
  'hybrid-rag': { status: 'live-adapter', description: 'Local neural embedding + lexical fusion + cross-encoder reranking; paired requests use Codex Luna for answers.' },
  'agentic-rag': { status: 'live-adapter', description: 'Iterative Codex Luna search planning over authorized BM25 retrieval and source passages.' },
  'graphrag': { status: 'live-adapter', description: 'Luna entity/relation extraction, weighted Louvain communities, persisted community summaries and retrieval.' },
  'full-source-agent': { status: 'live-adapter', description: 'Codex Luna reads complete authorized source files mounted in its isolated workspace.' },
  'skr-direct': { status: 'executable-reference', description: 'Exact SKE matching only; explicit rules are disabled.' },
  'skr-full': { status: 'executable-reference', description: 'Goal-directed scoped semantic retrieval and independent assertion review, exact matching, relevant explicit rule replay, and receipt-bound procedure assessments in live mode.' }
};

function ast(text) { return typeof text === 'string' ? parseSKE(text) : text; }

/** Explicit allow-list means gold and adjudication notes never enter runner input. */
export function buildRunnerInput(testCase, baseline) {
  const records = structuredClone(testCase.records ?? []);
  const sourcesByVersion = new Map();
  for (const r of records) if (r.sourceVersionId && r.regionId) {
    if (!sourcesByVersion.has(r.sourceVersionId)) sourcesByVersion.set(r.sourceVersionId, { id: r.sourceVersionId, sourceVersionId: r.sourceVersionId, regions: [] });
    const src = sourcesByVersion.get(r.sourceVersionId);
    if (!src.regions.some(x => x.id === r.regionId)) src.regions.push({ id: r.regionId, text: r.quote ?? '' });
  }
  return {
    question: testCase.question,
    goal: ast(testCase.goal),
    scope: testCase.scopeQuery,
    sourceScope: testCase.scope,
    snapshot: { id: `fixture_${testCase.id}`, records, rules: baseline === 'skr-direct' ? [] : structuredClone(testCase.rules ?? []), sources: [...sourcesByVersion.values()] },
    policy: {}
  };
}

function familyMetrics(items) {
  const total = items.length;
  const mean = field => { const xs=items.map(x=>x[field]).filter(Number.isFinite); return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null; };
  const claimCount=items.reduce((n,x)=>n+(x.claimCount??0),0),supportedCount=items.reduce((n,x)=>n+(x.supportedClaimCount??0),0);
  return {
    cases: total,
    answerAccuracy: mean('answerCorrect'),
    bindingAccuracy: mean('bindingCorrect'),
    evidencePrecision: mean('evidencePrecision'),
    evidenceRecall: mean('evidenceRecall'),
    supportedClaimFraction: claimCount?supportedCount/claimCount:null,
    claimsAudited:claimCount,
    residualAccuracy: mean('residualCorrect'),
    wallMs: items.reduce((s,x)=>s+x.wallMs,0)
  };
}

export async function runEvaluation({ fixturePath = 'fixtures/controlled.json', baselines = Object.keys(BASELINES) } = {}) {
  const absolute = resolvePath(fixturePath), bytes = await readFile(absolute), fixture = JSON.parse(bytes.toString('utf8'));
  let freezeManifest=null;try{freezeManifest=JSON.parse(await readFile(`${absolute}.lock.json`,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const inputDigest=createHash('sha256').update(bytes).digest('hex');
  if(freezeManifest&&freezeManifest.sha256!==inputDigest)throw new Error(`Frozen case manifest mismatch for ${absolute}; expected ${freezeManifest.sha256}, received ${inputDigest}`);
  const results = [], started = performance.now();
  for (const baseline of baselines) {
    const adapter = BASELINES[baseline];
    if (!adapter) { results.push({ baseline, status: 'unknown' }); continue; }
    if (adapter.status !== 'executable-reference') { results.push({ baseline, status: adapter.status, reason: adapter.reason, cost: { wallMs: null, modelCost: null, modelCostStatus: 'unavailable' } }); continue; }
    const cases = [];
    for (const c of fixture.cases) {
      const t0 = performance.now(), input = buildRunnerInput(c, baseline), output = runResolve(input), wallMs = performance.now() - t0;
      const predicted = output.answerPackage.supportState;
      const expected = c.expected;
      const valueKey=v=>typeof v==='string'?v:v?.type?printSKE(v):JSON.stringify(v);
      const rowKey=entries=>JSON.stringify(entries.map(([k,v])=>[k.replace(/^\?/,'') ,valueKey(v)]).sort((a,b)=>a[0].localeCompare(b[0])));
      const predictedBindingRows=output.answerPackage.claims.map(c=>Object.entries(c.bindings??{})).filter(x=>x.length).map(rowKey).sort();
      const expectedBindings=(c.gold?.bindings??[]).map(b=>Object.entries(b)).map(rowKey).sort();
      const bindingCorrect = expectedBindings.length === 0 ? null : JSON.stringify(predictedBindingRows)===JSON.stringify(expectedBindings) ? 1 : 0;
      const foundEvidence = new Set(output.evidence.filter(e => e.type === 'source').map(e => e.id));
      const goldEvidence = c.gold?.recordIds ?? [];
      const overlap = goldEvidence.filter(id => foundEvidence.has(id)).length;
      const evidencePrecision = goldEvidence.length ? (foundEvidence.size ? overlap / foundEvidence.size : 0) : null;
      const evidenceRecall = goldEvidence.length ? overlap / goldEvidence.length : null;
      const audit = auditEvidence({ answerPackage: output.answerPackage, evidence: output.evidence, snapshot: input.snapshot, sourceScope: input.sourceScope });
      const claimCount = output.answerPackage.claims.length;
      const supportedClaimCount=output.answerPackage.claims.filter(c=>c.supportState==='supported'&&audit.status==='valid').length;
      let residualCorrect=null;
      if(Array.isArray(c.gold?.residualPredicates)){const found=new Set(output.answerPackage.residuals.flatMap(r=>{try{const a=typeof r.goal==='string'?parseSKE(r.goal):r.goal;return a?.type==='call'?[a.predicate]:[];}catch{return[];}}));residualCorrect=c.gold.residualPredicates.every(p=>found.has(p))?1:0;}
      else if(expected==='supported')residualCorrect=output.answerPackage.residuals.length===0?1:0;
      const row = { baseline, caseId: c.id, family: c.family, expected, predicted, answerCorrect: expected===predicted?1:0, bindingCorrect, evidencePrecision, evidenceRecall, auditStatus: audit.status, supportedClaimFraction:claimCount?supportedClaimCount/claimCount:null,claimCount,supportedClaimCount,residualCorrect, residuals: output.answerPackage.residuals, wallMs, modelCost: null };
      cases.push(row); results.push(row);
    }
    const families = Object.fromEntries([...new Set(cases.map(c=>c.family))].map(f => [f, familyMetrics(cases.filter(c=>c.family===f))]));
    results.push({ baseline, status: adapter.status, description: adapter.description, metricsByFamily: families, aggregate: familyMetrics(cases), cost: { wallMs: cases.reduce((n,x)=>n+x.wallMs,0), modelCost: null, modelCostStatus: 'not-applicable-local-reference', ingestionCost: null, amortizedCost: null } });
  }
  const fullCases = results.filter(r => r.baseline === 'skr-full' && r.caseId);
  const acceptanceFailures = fullCases.filter(r => r.answerCorrect !== 1 || r.bindingCorrect === 0 || r.auditStatus !== 'valid').map(r => ({ caseId:r.caseId, answerCorrect:r.answerCorrect, bindingCorrect:r.bindingCorrect, auditStatus:r.auditStatus }));
  const directMultiHop = results.find(r => r.baseline === 'skr-direct' && r.caseId === 'three-hop-1');
  if (directMultiHop && directMultiHop.predicted !== 'unresolved') acceptanceFailures.push({ caseId:directMultiHop.caseId, baseline:'skr-direct', expected:'unresolved', predicted:directMultiHop.predicted });
  const fullById=new Map(results.filter(r=>r.baseline==='skr-full'&&r.caseId).map(r=>[r.caseId,r.answerCorrect])),directById=new Map(results.filter(r=>r.baseline==='skr-direct'&&r.caseId).map(r=>[r.caseId,r.answerCorrect]));
  const deltas=[...fullById].filter(([id])=>directById.has(id)).map(([id,value])=>value-directById.get(id));
  let seed=parseInt(createHash('sha256').update(bytes).digest('hex').slice(0,8),16)>>>0;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};const replicates=5000,boot=[];
  for(let b=0;b<replicates&&deltas.length;b++){let sum=0;for(let i=0;i<deltas.length;i++)sum+=deltas[Math.floor(random()*deltas.length)];boot.push(sum/deltas.length);}boot.sort((a,b)=>a-b);
  const meanDelta=deltas.length?deltas.reduce((a,b)=>a+b,0)/deltas.length:null;
  const pairedComparison={metric:'case-level exact answer classification accuracy',treatment:'skr-full',reference:'skr-direct',pairedCases:deltas.length,meanDifference:meanDelta,bootstrap95PercentileInterval:deltas.length?[boot[Math.floor(replicates*0.025)],boot[Math.min(replicates-1,Math.floor(replicates*0.975))]]:null,bootstrapReplicates:deltas.length?replicates:0,seedSource:'frozen fixture SHA-256',interpretation:'Synthetic controlled-case comparison only; interval describes this generated test fixture and is not a population or research-quality confidence interval.'};
  return { status: acceptanceFailures.length ? 'failed' : 'passed', acceptanceFailures, fixtureId: fixture.id, fixtureSha256: inputDigest, freezeManifest:freezeManifest?{verified:true,freezeVersion:freezeManifest.freezeVersion}:null, fixtureFrozen: fixture.frozen, caseCount: fixture.cases.length, pairedComparison, results, elapsedMs: performance.now() - started, interpretation: 'Controlled fixture smoke evaluation only. These values do not represent the minimum credible research release. Gold remains outside runner inputs; supportedClaimFraction reports structural audit state, not semantic claim quality.' };
}

// Live, paired comparison and public-book retrieval runner share the same callable
// baseline implementations but keep proposed gold outside the runner's arguments.
export { BASELINE_IDS, runBaselineRequest, runResearchComparison, runBookOfflineEvaluation, buildHybridIndex, hybridSearch, bm25Search, makeSourceChunks, createBaselineSession } from './baselines.mjs';
export { generateProcedureCases, runProcedureEvaluation } from './procedures.mjs';

export { buildMutationFixture, runMutationEvaluation } from './mutations.mjs';
