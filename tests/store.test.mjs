import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ProjectStore } from '../src/store.mjs';
import { queryKnowledge } from '../src/query/index.mjs';

async function withStore(fn) { const dir = await mkdtemp(path.join(os.tmpdir(), 'skr-store-')); try { await fn(new ProjectStore({ rootDir: dir }), dir); } finally { await rm(dir, { recursive: true, force: true }); } }

test('projects persist, children pin parent snapshots and siblings stay isolated', async () => withStore(async (store, dir) => {
  const root = await store.createProject('Base');
  const source = await store.registerSource(root.id, { name: 'one.txt', content: 'v1', mimeType: 'text/plain' });
  const childA = await store.forkProject(root.id, source.snapshot.id, 'A');
  const childB = await store.forkProject(root.id, source.snapshot.id, 'B');
  await store.registerSource(root.id, { name: 'two.txt', content: 'v2', mimeType: 'text/plain' });
  await store.registerSource(childA.id, { name: 'local.txt', content: 'local', mimeType: 'text/plain' });
  assert.equal((await store.getSnapshot(childA.id)).sources.length, 2);
  assert.equal((await store.getSnapshot(childB.id)).sources.length, 1);
  assert.equal((await store.getSnapshot(root.id)).sources.length, 2);
  assert.equal((await new ProjectStore({ rootDir: dir }).getSnapshot(childB.id)).sources.length, 1);
}));

test('source originals reopen by version ID after later update and preserve bytes', async () => withStore(async store => {
  const p = await store.createProject('P');
  const first = await store.registerSource(p.id, { name: 'x.txt', content: Buffer.from([0, 255, 10]), sourceId: 'book' });
  await store.registerSource(p.id, { name: 'x.txt', content: 'new', sourceId: 'book' });
  assert.deepEqual(await store.readSource(first.source.id), Buffer.from([0, 255, 10]));
}));

test('optimistic conflict leaves head unchanged and cloned views cannot mutate snapshots', async () => withStore(async store => {
  const p = await store.createProject('P'), base = p.snapshot.id;
  const view = await store.getSnapshot(p.id); view.policy.mutable = true;
  assert.deepEqual((await store.getSnapshot(p.id)).policy, {});
  await store.commit(p.id, base, { policy: { mode: 'strict' } });
  const head = (await store.getProject(p.id)).headSnapshotId;
  await assert.rejects(store.commit(p.id, base, { policy: { mode: 'bad' } }), { code: 'SNAPSHOT_CONFLICT' });
  assert.equal((await store.getProject(p.id)).headSnapshotId, head);
}));

test('source and procedure updates stale derived records transitively', async () => withStore(async store => {
  const p = await store.createProject('P');
  const s1 = await store.registerSource(p.id, { name: 'x.txt', content: 'old', sourceId: 'book' });
  let snap = await store.commit(p.id, s1.snapshot.id, { procedures: [{ id: 'rubric', version: '1', body: 'v1' }], records: [{ id: 'a', sourceVersionId: s1.source.id, dependencies: [s1.source.id], procedureId: 'rubric', procedureVersion: '1', lifecycle: 'fresh' }, { id: 'b', dependencies: ['a'], lifecycle: 'fresh' }] });
  snap = await store.commit(p.id, snap.id, { procedures: [{ id: 'rubric', version: '2', body: 'v2', lifecycle:'draft', validation:'unreviewed', active:false }] });
  assert.equal((await store.getSnapshot(p.id)).procedures.find(x => x.id === 'rubric' && x.version === '1').active, true);
  assert.equal((await store.getSnapshot(p.id)).records.find(x=>x.id==='a').lifecycle,'fresh');
  snap = await store.approveProcedure(p.id,snap.id,{id:'rubric',version:'2',reviewedBy:'manager'});
  assert.equal((await store.getSnapshot(p.id)).procedures.find(x => x.id === 'rubric' && x.version === '1').active, false);
  assert.equal((await store.getSnapshot(p.id)).records.find(x=>x.id==='a').lifecycle,'stale');
  snap = await store.registerSource(p.id, { name: 'x.txt', content: 'new', sourceId: 'book' }).then(x => x.snapshot);
  assert.equal((await store.getSnapshot(p.id)).records.find(r => r.id === 'b').lifecycle, 'stale');
}));

test('rebase keeps cumulative child delta and stales findings after parent procedure change', async () => withStore(async store => {
  const base = await store.createProject('Base');
  let parent = await store.commit(base.id, base.snapshot.id, { procedures: [{ id: 'p', version: '1' }] });
  const child = await store.forkProject(base.id, parent.id, 'Child');
  let cs = await store.registerSource(child.id, { name: 'local.txt', content: 'local' });
  cs = await store.commit(child.id, cs.snapshot.id, { records: [{ id: 'finding', procedureId: 'p', procedureVersion: '1', dependencies: [], lifecycle: 'fresh' }] });
  parent = await store.commit(base.id, parent.id, { procedures: [{ id: 'p', version: '2', lifecycle:'draft', validation:'unreviewed', active:false }] });
  assert.equal(parent.procedures.find(x=>x.id==='p'&&x.version==='1').active,true);
  parent=await store.approveProcedure(base.id,parent.id,{id:'p',version:'2',reviewedBy:'manager'});
  const rebased = await store.rebaseProject(child.id, parent.id);
  assert.ok(rebased.sources.some(s => s.id === cs.source?.id) || rebased.sources.some(s => s.name === 'local.txt'));
  assert.equal(rebased.records.find(r => r.id === 'finding').lifecycle, 'stale');
  assert.ok((await store.getAncestry(child.id)).some(x => x.snapshotId === parent.id));
}));

test('rebase preserves parent active procedure history alongside a child inactive draft', async () => withStore(async store => {
  const parent=await store.createProject('Procedure parent');
  let head=await store.commit(parent.id,parent.snapshot.id,{procedures:[{id:'p',version:'1',body:'one'}]});
  const child=await store.forkProject(parent.id,head.id,'Procedure child');
  let childHead=await store.commit(child.id,child.snapshot.id,{procedures:[{id:'p',version:'2',body:'two',active:false,lifecycle:'draft',validation:'unreviewed'}]});
  head=await store.commit(parent.id,head.id,{procedures:[{id:'p',version:'2',body:'two',active:false,lifecycle:'draft',validation:'unreviewed'}]});
  head=await store.approveProcedure(parent.id,head.id,{id:'p',version:'2',reviewedBy:'parent-manager'});
  head=await store.commit(parent.id,head.id,{procedures:[{id:'p',version:'3',body:'three',active:false,lifecycle:'draft',validation:'unreviewed'}]});
  head=await store.approveProcedure(parent.id,head.id,{id:'p',version:'3',reviewedBy:'parent-manager'});
  const rebased=await store.rebaseProject(child.id,head.id);
  const versions=rebased.procedures.filter(p=>p.id==='p');
  assert.deepEqual(versions.map(p=>[p.version,p.active]),[['1',false],['2',false],['3',true]]);
}));

test('rebase rejects competing local and parent definitions for the same procedure version', async () => withStore(async store => {
  const parent=await store.createProject('Procedure conflict parent');
  const head=await store.commit(parent.id,parent.snapshot.id,{procedures:[{id:'p',version:'1',body:'one'}]});
  const child=await store.forkProject(parent.id,head.id,'Procedure conflict child');
  await store.commit(child.id,child.snapshot.id,{procedures:[{id:'p',version:'2',body:'local two',active:false,lifecycle:'draft',validation:'unreviewed'}]});
  const upstream=await store.commit(parent.id,head.id,{procedures:[{id:'p',version:'2',body:'parent two',active:false,lifecycle:'draft',validation:'unreviewed'}]});
  await store.approveProcedure(parent.id,upstream.id,{id:'p',version:'2',reviewedBy:'parent-manager'});
  await assert.rejects(store.rebaseProject(child.id,(await store.getProject(parent.id)).headSnapshotId),/competing definitions/);
}));

test('parallel optimistic commits allow one winner and preserve exact nested ancestry after rebase', async () => withStore(async store => {
  const root = await store.createProject('Root');
  const r1 = await store.commit(root.id, root.snapshot.id, { policy: { v: 1 } });
  const middle = await store.forkProject(root.id, r1.id, 'Middle');
  const r2 = await store.commit(root.id, r1.id, { policy: { v: 2 } });
  const m2 = await store.rebaseProject(middle.id, r2.id);
  const leaf = await store.forkProject(middle.id, m2.id, 'Leaf');
  const a = store.commit(leaf.id, leaf.snapshot.id, { policy: { left: 1 } });
  const b = store.commit(leaf.id, leaf.snapshot.id, { policy: { right: 1 } });
  const outcomes = await Promise.allSettled([a, b]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected' && x.reason.code === 'SNAPSHOT_CONFLICT').length, 1);
  const r3 = await store.commit(root.id, r2.id, { policy: { v: 3 } });
  await store.rebaseProject(middle.id, r3.id);
  const ancestry = await store.getAncestry(leaf.id);
  assert.equal(ancestry[1].snapshotId, m2.id);
  assert.equal(ancestry[2].snapshotId, r2.id);
}));

test('newly computed findings at the new procedure version stay fresh and versions cannot mutate', async () => withStore(async store => {
  const p = await store.createProject('P');
  let s = await store.commit(p.id, p.snapshot.id, { procedures: [{ id: 'p', version: '1', body: 'one' }] });
  s = await store.commit(p.id, s.id, { procedures: [{ id: 'p', version: '2', body: 'two' }], records: [{ id: 'new-finding', procedureId: 'p', procedureVersion: '2', dependencies: [], lifecycle: 'fresh' }] });
  assert.equal(s.records.find(r => r.id === 'new-finding').lifecycle, 'fresh');
  await assert.rejects(store.commit(p.id, s.id, { procedures: [{ id: 'p', version: '2', body: 'changed' }] }), /immutable/);
}));

test('filesystem project lock serializes independent Node processes using the same expected head', async () => withStore(async (store, dir) => {
  const p = await store.createProject('Multi-process');
  const code = `import {ProjectStore} from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)}; const s=new ProjectStore({rootDir:process.argv[1]}); try { const x=await s.commit(process.argv[2],process.argv[3],{policy:{writer:process.argv[4]}}); process.stdout.write(JSON.stringify({ok:true,id:x.id})); } catch(e) { process.stdout.write(JSON.stringify({ok:false,code:e.code,message:e.message})); }`;
  const run = (label) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir, p.id, p.snapshot.id, label], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.setEncoding('utf8').on('data', x => out += x); child.stderr.setEncoding('utf8').on('data', x => err += x);
    child.on('error', reject); child.on('close', status => status === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
  const results = await Promise.all([run('one'), run('two')]);
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.equal(results.filter(x => !x.ok && x.code === 'SNAPSHOT_CONFLICT').length, 1);
  assert.ok((await store.getSnapshot(p.id)).policy.writer);
}));

test('trusted entity merge invalidates dependent findings and restores prior identities from its server-side journal on undo', async () => withStore(async store => {
  const project=await store.createProject('Entity reconciliation');
  const registered=await store.registerSource(project.id,{name:'entities.txt',sourceId:'entity_book',content:'Rabbit enters the garden.\nRabbit eats a carrot.',mimeType:'text/plain'});
  let snapshot=registered.snapshot; const source=snapshot.sources.find(s=>s.sourceId==='entity_book'), [r1,r2]=source.regions;
  const alias={id:'claim_alias',type:'source-assertion',ske:'(enters entity_alias garden)',sourceVersionId:source.sourceVersionId,sourceId:source.sourceId,regionId:r1.id,quote:r1.text,entityMentions:[{surface:'Rabbit',entityId:'entity_alias'}],lifecycle:'current',supportState:'supported',validation:'model-reviewed'};
  const canonical={id:'claim_canonical',type:'source-assertion',ske:'(eats entity_rabbit carrot)',sourceVersionId:source.sourceVersionId,sourceId:source.sourceId,regionId:r2.id,quote:r2.text,entityMentions:[{surface:'Rabbit',entityId:'entity_rabbit'}],lifecycle:'current',supportState:'supported',validation:'model-reviewed'};
  snapshot=await store.commit(project.id,snapshot.id,{records:[alias,canonical,{id:'dependent_finding',type:'procedure-finding',dependencies:[alias.id],lifecycle:'current',supportState:'unresolved'}]});
  assert.equal((await queryKnowledge({snapshot,goal:'(enters entity_alias garden)'})).matches.length,1);
  const merged=await store.reconcileEntities(project.id,snapshot.id,{fromEntityId:'entity_alias',toEntityId:'entity_rabbit',reviewedBy:'reviewer_local'});
  assert.equal((await queryKnowledge({snapshot:merged.snapshot,goal:'(enters entity_rabbit garden)'})).matches.length,1);
  assert.equal((await queryKnowledge({snapshot:merged.snapshot,goal:'(enters entity_alias garden)'})).matches.length,0);
  assert.equal(merged.snapshot.records.find(r=>r.id==='dependent_finding').lifecycle,'stale');
  const undone=await store.undoEntityReconciliation(project.id,merged.snapshot.id,merged.operationId,{reviewedBy:'reviewer_local'});
  assert.equal((await queryKnowledge({snapshot:undone.snapshot,goal:'(enters entity_alias garden)'})).matches.length,1);
  assert.equal((await queryKnowledge({snapshot:undone.snapshot,goal:'(enters entity_rabbit garden)'})).matches.length,0);
  assert.equal(undone.snapshot.records.find(r=>r.id==='claim_alias').validation,'model-reviewed');
  assert.equal(undone.snapshot.entityReconciliations.filter(e=>e.action==='undo'&&e.undoOf===merged.operationId).length,1);
}));
