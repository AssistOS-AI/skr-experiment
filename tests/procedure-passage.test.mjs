import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.mjs';
import { materializeProcedures } from '../src/ingestion/index.mjs';
import { validateChangeSet } from '../src/runtime/change-validation.mjs';
import { auditEvidence } from '../src/engine/index.mjs';
import { openSourceRegion } from '../src/query/index.mjs';

test('raw passage procedure evidence validates, commits, reopens and survives a new-query audit', async () => {
  const rootDir=await mkdtemp(path.join(os.tmpdir(),'skr-passage-store-'));
  try {
    const store=new ProjectStore({rootDir}),project=await store.createProject('Passage evidence');
    const content='Front matter.\n*** START OF THE PROJECT GUTENBERG EBOOK SAMPLE ***\nThe rabbit crossed the meadow.\nThe fox watched from a hill.\n*** END OF THE PROJECT GUTENBERG EBOOK SAMPLE ***\nLicense text.';
    const added=await store.registerSource(project.id,{name:'passage.txt',content});
    const procedure={id:'document-literary-rubric',version:'1.0.0',active:true,purpose:'Record evidence-led observations',type:'rubric',ordered_steps:['Inspect all supplied passages','Relate passage to criterion'],evidence_obligations:['Retain exact passage evidence'],output_schema:{type:'array',items:{type:'object'}}};
    let snapshot=await store.commit(project.id,added.snapshot.id,{procedures:[procedure]});
    const pinned=await store.getSnapshot(project.id,snapshot.id),source=pinned.sources[0],sourceScope=[source.sourceVersionId];
    assert.equal(source.workBoundaries.type,'project-gutenberg-work-v2');
    assert.deepEqual(source.regions.filter(r=>r.sourceSegment==='work').map(r=>r.text),['The rabbit crossed the meadow.','The fox watched from a hill.']);
    const session={request:async({schema})=>{
      assert.deepEqual(schema.properties.chunkId.enum,['chunk_1']);
      const firstNarrative=source.regions.find(r=>r.sourceSegment==='work');
      const id=`passage_${createHash('sha256').update(`${source.sourceVersionId}:${firstNarrative.id}`).digest('hex').slice(0,24)}`;
      assert.ok(id);
      return {output:{chunkId:'chunk_1',findings:[{summary:'The event is narrated directly.',evidenceIds:[id],counterevidenceIds:[],supportState:'unresolved',score:null,criterion:'Narration'}],coverage:{reviewStatus:'complete',unreviewedRegionIds:[]}},sessionId:'offline-test'};
    }};
    const bundle=await materializeProcedures({snapshot:pinned,procedureIds:[{id:procedure.id,version:procedure.version}],parameters:{criteria:['Narration']},sourceScope,session});
    assert.equal(bundle.validation.regionsConsidered,2);
    assert.equal(bundle.validation.totalSourceRegions,6);
    assert.equal(bundle.validation.intentionallyExcludedRegions,4);
    assert.equal(bundle.validation.incompleteRegions,0);
    const validated=validateChangeSet({changeSet:bundle.changeSet,taskType:'APPLY_PROCEDURE',snapshot:pinned,sourceScope,evidence:bundle.evidence,reviewReceipts:bundle.reviewReceipts});
    snapshot=await store.commit(project.id,pinned.id,validated);
    const persisted=await store.getSnapshot(project.id,snapshot.id),finding=persisted.records.find(r=>r.type==='procedure-finding');
    assert.ok(finding);
    const passageId=finding.evidenceIds[0],region=persisted.sources[0].regions.find(r=>r.sourceSegment==='work');
    assert.equal(passageId,`passage_${createHash('sha256').update(`${source.sourceVersionId}:${region.id}`).digest('hex').slice(0,24)}`);
    const opened=await openSourceRegion({snapshot:persisted,sourceVersionId:source.sourceVersionId,regionId:region.id,sourceScope});
    assert.equal(opened.quote,region.text);
    const evidence=[{id:finding.id,type:'procedure-finding',...structuredClone(finding)},{id:passageId,type:'source',sourceVersionId:source.sourceVersionId,regionId:region.id,quote:region.text,locator:region.locator}];
    const audited=auditEvidence({answerPackage:{answer:'A procedural assessment is available.',supportState:'unresolved',claims:[{text:finding.summary,supportState:'unresolved',evidenceIds:[finding.id]}]},evidence,snapshot:persisted,sourceScope});
    assert.equal(audited.status,'valid',JSON.stringify(audited.errors));
  } finally { await rm(rootDir,{recursive:true,force:true}); }
});
