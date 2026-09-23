import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSemantics } from '../src/engine/semantic-resolution.mjs';

test('semantic resolver interprets, retrieves, separately reviews and returns ephemeral evidence', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'skr-semantic-'));
  try {
    const snapshot={id:'snap_sem',records:[],sources:[{id:'srcv_sem',sourceVersionId:'srcv_sem',sourceId:'src_sem',name:'Fixture',digest:'abc',regions:[{id:'r1',text:'There were four little Rabbits.',locator:{line:1}}]}]};
    let reviewTurn=0;
    const session={request:async ({prompt})=>{
      if(prompt.includes("Interpret the user's question"))return {output:{goal:'(count rabbits 4)',scope:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:null},reasoningNotes:'count question'},sessionId:'s1'};
      if(prompt.includes('separate semantic reviewer')){reviewTurn++;return {output:{reviews:[{candidateId:'sem_candidate',decision:'entailed',rationale:'Explicit count.',qualifiers:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:null},entityDecisions:[],counterevidence:[]}]},sessionId:'s1'};}
      if(prompt.includes('Advance this semantic goal'))return {output:{proposals:[{ske:'(count rabbits 4)',sourceVersionId:'srcv_sem',regionId:'r1',quote:'There were four little Rabbits.',qualifiers:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:null},entities:[],why:'explicit count'}],subgoals:[],uncertainties:[]},sessionId:'s1'};
      throw new Error('unexpected session prompt');
    }};
    // reviewAssertions generates a stable candidate ID; adapt the reviewer response to it.
    const original=session.request;session.request=async args=>{const r=await original(args);if(args.prompt.includes('separate semantic reviewer')){const marker='Candidates, exact cited text, and neighboring context:\n';r.output.reviews[0].candidateId=JSON.parse(args.prompt.slice(args.prompt.indexOf(marker)+marker.length))[0].candidateId;}return r;};
    const result=await resolveSemantics({question:'How many rabbits?',snapshot,sourceScope:['srcv_sem'],session,checkpointDir:dir,maxIterations:2});
    assert.equal(reviewTurn,1);
    assert.equal(result.answerPackage.supportState,'supported');
    assert.match(result.answerPackage.answer,/count rabbits 4/);
    assert.equal(result.evidence[0].quote,'There were four little Rabbits.');
    assert.equal(result.evidence[0].ephemeral,true);
    assert.equal(result.reviewReceipts.length,1);
    assert.equal(result.candidates[0].validation,'model-reviewed');
    assert.deepEqual(result.checkpoint.status,'complete');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('interpretation uses authorized predicate and entity vocabulary without treating it as extra evidence', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'skr-semantic-catalog-'));
  try {
    const snapshot={id:'snap_catalog',sources:[{id:'v',sourceId:'s',name:'Rabbit story',regions:[{id:'r',text:'There were four little Rabbits.',locator:{line:1}}]}],records:[
      {id:'count4',ske:'(count rabbits 4)',sourceVersionId:'v',sourceId:'s',regionId:'r',lifecycle:'current',supportState:'supported',validation:'source-checked',entityMentions:[{entityId:'ent_rabbits',surface:'little Rabbits',canonicalName:'rabbits',decision:'existing'}]}
    ]};
    let interpretationPrompt='';
    const session={request:async({prompt})=>{
      interpretationPrompt=prompt;
      return {output:{goal:'(find (?n) (count rabbits ?n))',scope:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:null},reasoningNotes:'Reused the scoped relation and entity.'},sessionId:'catalog-test'};
    }};
    const result=await resolveSemantics({question:'How many little rabbits were there?',snapshot,sourceScope:['v'],session,checkpointDir:dir});
    assert.match(interpretationPrompt,/Authorized scoped semantic catalog/);
    assert.match(interpretationPrompt,/"predicate":"count"/);
    assert.match(interpretationPrompt,/"canonicalName":"rabbits"/);
    assert.equal(result.answerPackage.supportState,'supported');
    assert.equal(result.answerPackage.claims[0].bindings.n.value,4);
    assert.deepEqual(result.ephemeralRecords,[]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('semantic resolver will not promote retrieved prose without an independent review receipt', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'skr-semantic-'));
  try {
    const snapshot={id:'snap_sem2',records:[],sources:[{id:'v',sourceId:'s',regions:[{id:'r',text:'The fox watched the moon.',locator:{line:1}}]}]};
    const session={request:async ({prompt})=>{
      if(prompt.includes("Interpret the user's question"))return {output:{goal:'(owns fox moon)',scope:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:null},reasoningNotes:''},sessionId:'s2'};
      if(prompt.includes('Advance this semantic goal'))return {output:{proposals:[{ske:'(owns fox moon)',sourceVersionId:'v',regionId:'r',quote:'The fox watched the moon.',qualifiers:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:null},entities:[],why:'proposal'}],subgoals:[],uncertainties:[]},sessionId:'s2'};
      if(prompt.includes('separate semantic reviewer'))return {output:{reviews:[]},sessionId:'s2'};
      throw new Error('unexpected prompt');
    }};
    const result=await resolveSemantics({question:'Who owns the moon?',snapshot,sourceScope:['v'],session,checkpointDir:dir,maxIterations:1});
    assert.equal(result.answerPackage.supportState,'unresolved');
    assert.equal(result.candidates.length,0);
    assert.ok(result.answerPackage.residuals.some(r=>/review omitted/.test(r.reason)));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('caller-supplied variable queries are preserved and subgoal evidence cannot answer the root goal', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'skr-semantic-'));
  try {
    const snapshot={id:'snap_sem3',sources:[{id:'v',sourceId:'s',regions:[{id:'r',text:'The fox watches the moon.',locator:{line:1}}]}],records:[{id:'f1',ske:'(owns rabbit burrow)',sourceVersionId:'v',sourceId:'s',regionId:'r',lifecycle:'current',supportState:'supported',validation:'source-checked'}]};
    const unused={request:async()=>{throw new Error('already answered structurally') }};
    const query=await resolveSemantics({goal:'(find (?x) (owns ?x burrow))',snapshot,sourceScope:['v'],session:unused,checkpointDir:path.join(dir,'query')});
    assert.equal(query.answerPackage.supportState,'supported');
    assert.deepEqual(query.answerPackage.claims[0].bindings,{x:{type:'atom',value:'rabbit'}});
    const session={request:async ({prompt})=>{
      if(prompt.includes('Advance this semantic goal'))return {output:{proposals:[],subgoals:[{goal:'(watches fox moon)',reason:'check the passage'}],uncertainties:[]},sessionId:'s3'};
      throw new Error('unexpected review/model request');
    }};
    const result=await resolveSemantics({goal:'(owns fox moon)',snapshot,sourceScope:['v'],session,checkpointDir:path.join(dir,'subgoal'),maxIterations:2});
    assert.equal(result.answerPackage.supportState,'unresolved');
    assert.equal(result.answerPackage.claims.length,0);
    assert.ok(result.ledger.iterations.some(x=>x.goal==='(watches fox moon)'));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('semantic checkpoint retries an interrupted running agenda item against the same pin', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'skr-semantic-'));
  try {
    const snapshot={id:'snap_sem4',sources:[{id:'v',sourceId:'s',regions:[{id:'r',text:'The rabbit ran.',locator:{line:1}}]}],records:[]};
    const failing={request:async ({prompt})=>{if(prompt.includes('Advance this semantic goal'))throw new Error('simulated interrupted turn');throw new Error('unexpected');}};
    await assert.rejects(resolveSemantics({goal:'(ran rabbit)',snapshot,sourceScope:['v'],session:failing,checkpointDir:dir,maxIterations:1}),/simulated interrupted/);
    let proposals=0;
    const resumed={request:async ({prompt})=>{if(prompt.includes('Advance this semantic goal')){proposals++;return {output:{proposals:[],subgoals:[],uncertainties:[]},sessionId:'s4'};}throw new Error('unexpected');}};
    const result=await resolveSemantics({goal:'(ran rabbit)',snapshot,sourceScope:['v'],session:resumed,checkpointDir:dir,maxIterations:1});
    assert.equal(proposals,1);
    assert.equal(result.checkpoint.status,'complete');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('goal-directed subgoal review discovers two facts and joins them to bind the root variable', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'skr-semantic-'));
  try {
    const snapshot={id:'snap_sem5',records:[],sources:[{id:'v',sourceId:'s',regions:[{id:'r1',text:'There were four rabbits.',locator:{line:1}},{id:'r2',text:'The rabbits were brown.',locator:{line:2}}]}]};
    const session={request:async({prompt,schema})=>{
      if(prompt.includes('Advance this semantic goal')){
        if(prompt.includes('Current goal: (find'))return {output:{proposals:[{ske:'(count rabbits 4)',sourceVersionId:'v',regionId:'r1',quote:'There were four rabbits.',qualifiers:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:null},entities:[],why:'explicit count'}],subgoals:[{goal:'(color rabbits brown)',reason:'find the rabbits’ color'}],uncertainties:[]},sessionId:'s5'};
        return {output:{proposals:[{ske:'(color rabbits brown)',sourceVersionId:'v',regionId:'r2',quote:'The rabbits were brown.',qualifiers:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:null},entities:[],why:'explicit color'}],subgoals:[],uncertainties:[]},sessionId:'s5'};
      }
      if(prompt.includes('separate semantic reviewer')){
        const candidateId=schema.properties.reviews.items.properties.candidateId.enum[0];
        return {output:{reviews:[{candidateId,decision:'entailed',rationale:'The source states this directly.',qualifiers:{attribution:null,time:null,modality:'asserted',polarity:'positive',world:null},entityDecisions:[],counterevidence:[]}]},sessionId:'s5'};
      }
      throw new Error('unexpected request');
    }};
    const result=await resolveSemantics({goal:'(find (?n) (and (count rabbits ?n) (color rabbits brown)))',snapshot,sourceScope:['v'],session,checkpointDir:dir,maxIterations:2});
    assert.equal(result.answerPackage.supportState,'supported');
    assert.deepEqual(result.answerPackage.claims[0].bindings,{n:{type:'number',value:4}});
    assert.equal(result.answerPackage.claims[0].evidenceIds.length,2);
    assert.equal(result.ephemeralRecords.length,2);
    assert.equal(result.reviewReceipts.length,2);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
