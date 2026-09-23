import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSKE, printSKE, match, reason, resolve, applyProcedure, auditEvidence, ingestSource } from '../src/engine/index.mjs';
import { makeReviewReceipt } from '../src/ingestion/receipts.mjs';

test('recursive predicate-first SKE round trips nested terms, literals and variadic predicates', () => {
  const source = '(asserts source:r (says person:lee "hello world" (and (x ?v) (y 3))))';
  assert.equal(printSKE(parseSKE(source)), source);
  assert.throws(() => parseSKE('(p a'), /Unclosed/);
});

test('unification handles repeated variables and rejects cyclic bindings', () => {
  assert.equal(match('(same ?x ?x)', [{id:'yes',ske:'(same a a)'}]).matches.length, 1);
  assert.equal(match('(same ?x ?x)', [{id:'no',ske:'(same a b)'}]).matches.length, 0);
  assert.equal(match('(p ?x)', [{id:'cycle',ske:'(p (f ?x))'}]).matches.length, 0);
});

test('shared-variable joins bind the same entity across predicates', () => {
  const q = parseSKE('(find (?s) (and (depends_on service:payment ?s) (located_in ?s region:eu)))');
  const r = match(q, [{id:'a',ske:'(depends_on service:payment service:id)'},{id:'b',ske:'(located_in service:id region:eu)'}]);
  assert.deepEqual(r.matches[0].bindings.s, {type:'atom',value:'service:id'});
  assert.deepEqual(r.matches[0].evidenceIds, ['a','b']);
  assert.deepEqual(Object.keys(r.matches[0].bindings), ['s']);
});

test('multi-hop rule closure records all premises and never reverses roles', () => {
  const records = [{id:'a',ske:'(depends_on gateway identity)'},{id:'b',ske:'(located_in identity eu)'}];
  const rules = [{id:'availability',version:'2',premises:['(depends_on ?x ?y)','(located_in ?y eu)'],conclusion:'(available ?x)'}];
  const closure = reason(records,rules);
  const d = closure.derivations[0];
  assert.equal(printSKE(d.ske),'(available gateway)');
  assert.deepEqual(d.premiseIds,['a','b']);
  assert.equal(match('(available gateway)',closure.records).matches.length,1);
  assert.equal(match('(depends_on identity gateway)',records).matches.length,0);
});

test('temporal, attributed, modal and negative claims stay qualified', () => {
  const records = [
    {id:'possible',ske:'(shutdown system)',modality:'possible'},
    {id:'dated',ske:'(active cache)',time:'2020'},
    {id:'reported',ske:'(secure db)',attribution:'analyst:lee'},
    {id:'no',ske:'(connected node)',polarity:'negative'}
  ];
  for (const r of records) assert.equal(match(r.ske,[r]).matches[0].relation,'ambiguous');
  assert.equal(resolve({goal:'(shutdown system)',snapshot:{records},question:'shutdown?'}).answerPackage.supportState,'unresolved');
  assert.equal(match('(active cache)',[records[1]],{scope:{time:'2020'}}).matches[0].relation,'equivalent');
});

test('same-scope opposition is contested while temporal revisions remain separate', () => {
  const facts = [{id:'p',ske:'(active cache)',time:'2020',polarity:'positive'},{id:'n',ske:'(active cache)',time:'2020',polarity:'negative'},{id:'p2',ske:'(active cache)',time:'2021',polarity:'positive'}];
  const same = match('(active cache)',facts.slice(0,2));
  assert.equal(same.matches[0].relation,'contested');
  assert.deepEqual(same.matches[0].evidenceIds,['p','n']);
  assert.equal(match('(active cache)',facts.slice(0,1)).matches[0].relation,'ambiguous');
  assert.ok(match('(active cache)',facts,{scope:{time:'2021',polarity:'positive'}}).matches.some(m => m.relation === 'equivalent'));
});

test('absence and source scope do not turn unsupported or foreign facts into answers', () => {
  const out = resolve({goal:'(approved billing)',question:'approved?',sourceScope:['mine'],snapshot:{records:[{id:'foreign',ske:'(approved billing)',sourceVersionId:'other',lifecycle:'current'}]}});
  assert.equal(out.answerPackage.supportState,'unresolved');
});

test('evidence audit reopens exact assertions and checks rule provenance', () => {
  const snapshot = {id:'snap',sources:[{id:'srcv1',regions:[{id:'p1',text:'The service is active.'}]}],records:[{id:'fact1',ske:'(active service)',sourceVersionId:'srcv1',regionId:'p1',lifecycle:'current'}]};
  const ev = {id:'fact1',type:'source',sourceVersionId:'srcv1',regionId:'p1',quote:'The service is active.',ske:parseSKE('(active service)')};
  const claim = {supportState:'supported',goal:parseSKE('(active service)'),bindings:{},evidenceIds:['fact1']};
  assert.equal(auditEvidence({answerPackage:{claims:[claim]},evidence:[ev],snapshot}).status,'valid');
  assert.equal(auditEvidence({answerPackage:{claims:[claim]},evidence:[{...ev,quote:'invented'}],snapshot}).status,'invalid');
  assert.equal(auditEvidence({answerPackage:{claims:[{supportState:'supported',evidenceIds:['d']}]},evidence:[{id:'d',type:'derived',premiseIds:['d'],transformation:'rule-replay'}],snapshot}).status,'invalid');
});

test('audit rejects a fabricated shared-variable join and permits raw quotes only as unresolved evidence', () => {
  const goal = parseSKE('(find (?x) (and (p ?x) (q ?x)))');
  const snapshot = { sources:[{id:'s',regions:[{id:'p',text:'P a'},{id:'q',text:'Q b'}]}], records:[
    {id:'pa',ske:'(p a)',sourceVersionId:'s',regionId:'p'}, {id:'qb',ske:'(q b)',sourceVersionId:'s',regionId:'q'}
  ]};
  const evidence = [
    {id:'pa',type:'source',sourceVersionId:'s',regionId:'p',quote:'P a',ske:parseSKE('(p a)')},
    {id:'qb',type:'source',sourceVersionId:'s',regionId:'q',quote:'Q b',ske:parseSKE('(q b)')}
  ];
  const fabricated = {supportState:'supported',claims:[{supportState:'supported',goal,bindings:{x:{type:'atom',value:'a'}},evidenceIds:['pa','qb']} ]};
  assert.equal(auditEvidence({answerPackage:fabricated,evidence,snapshot}).status,'invalid');
  const raw = {id:'raw',type:'source',sourceVersionId:'s',regionId:'p',quote:'P a'};
  assert.equal(auditEvidence({answerPackage:{supportState:'unresolved',claims:[{supportState:'unresolved',evidenceIds:['raw']}]},evidence:[raw],snapshot}).status,'valid');
});

test('evidence audit requires direct claim qualifiers to align with pinned assertion scope', () => {
  const snapshot = {sources:[{id:'s',regions:[{id:'r',text:'Possibly p x.'}]}],records:[{id:'possible-p',ske:'(p x)',sourceVersionId:'s',regionId:'r',modality:'possible',lifecycle:'current'}]};
  const evidence = [{id:'possible-p',type:'source',sourceVersionId:'s',regionId:'r',quote:'Possibly p x.',ske:parseSKE('(p x)'),modality:'possible'}];
  const base = {supportState:'supported',goal:parseSKE('(p x)'),bindings:{},evidenceIds:['possible-p']};
  assert.equal(auditEvidence({answerPackage:{supportState:'supported',claims:[base]},evidence,snapshot}).status,'invalid');
  assert.equal(auditEvidence({answerPackage:{supportState:'supported',claims:[{...base,queryScope:{modality:'possible'}}]},evidence,snapshot}).status,'valid');
});

test('evidence audit replays derived premises when agent output serializes SKE as text', () => {
  const snapshot = {
    sources:[{id:'s',regions:[{id:'p',text:'P a'},{id:'q',text:'Q a'}]}],
    records:[
      {id:'p-a',ske:'(p a)',sourceVersionId:'s',regionId:'p'},
      {id:'q-a',ske:'(q a)',sourceVersionId:'s',regionId:'q'}
    ],
    rules:[{id:'rule-r',version:'1',premises:['(p ?x)','(q ?x)'],conclusion:'(z ?x)'}]
  };
  const sources = [
    {id:'p-a',type:'source',sourceVersionId:'s',regionId:'p',quote:'P a',ske:'(p a)'},
    {id:'q-a',type:'source',sourceVersionId:'s',regionId:'q',quote:'Q a',ske:'(q a)'}
  ];
  const derived = {id:'d',type:'derived',premiseIds:['p-a','q-a'],transformation:'rule-replay',procedureId:'rule-r',procedureVersion:'1',ske:'(z a)',attribution:null,time:null,modality:'asserted',polarity:'positive',world:null};
  const answerPackage = {supportState:'supported',claims:[{supportState:'supported',goal:'(z a)',bindings:{},evidenceIds:['d']}]};
  assert.equal(auditEvidence({answerPackage,evidence:[...sources,derived],snapshot}).status,'valid');
  const astEvidence = [...sources, {...derived,ske:parseSKE('(z a)')}, {...sources[0],ske:parseSKE('(p a)')}, {...sources[1],ske:parseSKE('(q a)')}];
  assert.equal(auditEvidence({answerPackage,evidence:astEvidence,snapshot}).status,'valid');
});

test('find joins return contested with both evidence IDs when a premise has same-scope opposition', () => {
  const records = [{id:'p',ske:'(p a)',polarity:'positive'},{id:'not-p',ske:'(p a)',polarity:'negative'}];
  const out = resolve({question:'find p',goal:'(find (?x) (p ?x))',snapshot:{records}});
  assert.equal(out.answerPackage.supportState,'contested');
  assert.deepEqual(out.evidence.map(e=>e.id).sort(),['not-p','p']);
});

test('audit binds every material procedure finding field to the pinned reviewed record', () => {
  const source={id:'fact',ske:'(p a)',sourceVersionId:'s',regionId:'r',lifecycle:'current'};
  const finding={id:'finding',type:'procedure-finding',procedureId:'review',procedureVersion:'3',parameters:{criterion:'x'},summary:'Evidence supports criterion x.',score:0.8,criterion:'x',evidenceIds:['fact'],counterevidenceIds:[],dependencies:['fact'],sourceSnapshotId:'snap',supportState:'unresolved',lifecycle:'current',validation:'model-reviewed'};
  const snapshot={id:'snap',sources:[{id:'s',regions:[{id:'r',text:'P a.'}]}],records:[source,finding],procedures:[{id:'review',version:'3',active:true}]};
  const evidence=[{id:'fact',type:'source',sourceVersionId:'s',regionId:'r',quote:'P a.',ske:'(p a)'},structuredClone(finding)];
  const pkg={supportState:'unresolved',claims:[{supportState:'unresolved',evidenceIds:['finding']}]};
  assert.equal(auditEvidence({answerPackage:pkg,evidence,snapshot}).status,'valid');
  for(const mutation of [{summary:'Fabricated summary.'},{score:0.99},{criterion:'different'},{parameters:{criterion:'different'}},{procedureVersion:'2'}]){
    const altered=evidence.map(e=>e.id==='finding'?{...e,...mutation}:e);
    assert.equal(auditEvidence({answerPackage:pkg,evidence:altered,snapshot}).status,'invalid');
  }
});

test('audit accepts ephemeral semantic evidence only with its exact Luna review receipt',()=>{
  const snapshot={id:'snap',sources:[{id:'s',regions:[{id:'r',text:'Peter has four siblings.'}]}],records:[]};
  const record={id:'assertion',type:'source-assertion',ske:'(count rabbits 4)',sourceVersionId:'s',sourceId:'book',regionId:'r',quote:'Peter has four siblings.',qualifiers:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:null},attribution:null,time:null,modality:'asserted',polarity:'positive',world:null,entityMentions:[],counterevidence:[],lifecycle:'current',supportState:'supported',validation:'model-reviewed'};
  const receipt=makeReviewReceipt(record,{sessionId:'luna-review'}),evidence=[{id:'assertion',type:'source',ephemeral:true,sourceVersionId:'s',regionId:'r',quote:record.quote,ske:record.ske,qualifiers:record.qualifiers}];
  const answerPackage={supportState:'supported',claims:[{supportState:'supported',goal:'(count rabbits 4)',bindings:{},evidenceIds:['assertion']}]};
  assert.equal(auditEvidence({answerPackage,evidence,snapshot,sourceScope:['s'],ephemeralRecords:[record]}).status,'invalid');
  assert.equal(auditEvidence({answerPackage,evidence,snapshot,sourceScope:['s'],ephemeralRecords:[record],reviewReceipts:[receipt]}).status,'valid');
  assert.equal(auditEvidence({answerPackage,evidence:[{...evidence[0],quote:'invented'}],snapshot,sourceScope:['s'],ephemeralRecords:[record],reviewReceipts:[receipt]}).status,'invalid');
});

test('direct contradiction evidence respects scope authorization and usable status', () => {
  const positive = {id:'p',ske:'(p a)',sourceVersionId:'allowed',polarity:'positive'};
  const foreignNegative = {id:'n',ske:'(p a)',sourceVersionId:'foreign',polarity:'negative'};
  assert.equal(match('(p a)',[positive,foreignNegative],{sourceScope:['allowed']}).matches[0].relation,'equivalent');
  assert.equal(match('(p a)',[positive,{...foreignNegative,sourceVersionId:'allowed',supportState:'unresolved'}]).matches[0].relation,'equivalent');
});

test('nested qualifiers and staged records cannot silently become current facts', () => {
  const possible={id:'possible',ske:'(happened event)',qualifiers:{modality:'possible'},supportState:'supported',validation:'model-reviewed',lifecycle:'current'};
  const staged={id:'staged',ske:'(happened event)',supportState:'supported',validation:'source-checked',lifecycle:'staged'};
  assert.equal(match('(happened event)',[possible]).matches[0].relation,'ambiguous');
  assert.equal(match('(happened event)',[possible],{scope:{modality:'possible'}}).matches[0].relation,'equivalent');
  assert.equal(match('(happened event)',[staged]).matches.length,0);
  const negative={id:'negative',ske:'(happened event)',qualifiers:{polarity:'negative'},supportState:'supported',validation:'model-reviewed',lifecycle:'current'};
  assert.equal(match('(happened event)',[negative]).matches[0].relation,'ambiguous');
  assert.equal(match('(happened event)',[negative],{scope:{polarity:'negative'}}).matches[0].relation,'equivalent');
});

test('entity-reconciled source assertions require current lifecycle and explicit operation provenance',()=>{
  const missing={id:'bad',ske:'(p entity_new)',validation:'entity-reconciled',lifecycle:'current',supportState:'supported'};
  const valid={id:'good',ske:'(p entity_new)',validation:'entity-reconciled',lifecycle:'current',supportState:'supported',entityReconciliation:{operationId:'op_123',fromEntityId:'entity_old',toEntityId:'entity_new',reviewedBy:'gpt-6-luna'}};
  const stale={...valid,id:'stale',lifecycle:'stale'};
  assert.equal(match('(p entity_new)',[missing]).matches.length,0);
  assert.equal(match('(p entity_new)',[stale]).matches.length,0);
  assert.equal(match('(p entity_new)',[valid]).matches.length,1);
});

test('procedures preserve exact version and avoid claiming expert judgment; ingestion defers semantic extraction', () => {
  const snapshot = {records:[{id:'p',ske:'(claim x)',sourceVersionId:'s',regionId:'r',polarity:'positive'},{id:'n',ske:'(claim x)',sourceVersionId:'s',regionId:'r2',polarity:'negative'}]};
  const applied = applyProcedure({procedure:{id:'contradiction-audit',version:'7.2',parameters:{strict:true}},snapshot});
  assert.equal(applied.findings[0].procedureVersion,'7.2');
  assert.equal(applied.validation.expertJudgment,false);
  const ingested = ingestSource({id:'s',regions:[{id:'r',text:'A passage.'}]});
  assert.equal(ingested.coverage[0].state,'deferred');
  assert.equal(ingested.records.length,0);
});
