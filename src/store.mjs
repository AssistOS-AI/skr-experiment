import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, access, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readSourceContent } from './source-readers.mjs';
import { reconcileEntityAliases as planEntityAliases } from './ingestion/entities.mjs';

const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const clone = (v) => structuredClone(v);
const hash = (b) => createHash('sha256').update(b).digest('hex');

export class ProjectStore {
  constructor({ rootDir }) {
    if (!rootDir) throw new TypeError('rootDir is required');
    this.rootDir = path.resolve(rootDir);
    this.projectsDir = path.join(this.rootDir, 'projects');
    this.snapshotsDir = path.join(this.rootDir, 'snapshots');
    this.objectsDir = path.join(this.rootDir, 'objects');
    this.runsDir = path.join(this.rootDir, 'runs');
    this.locksDir = path.join(this.rootDir, '.locks');
    this.ready = Promise.all([this.projectsDir, this.snapshotsDir, this.objectsDir, this.runsDir, this.locksDir].map(d => mkdir(d, { recursive: true })));
    this.locks = new Map();
  }
  _id(id, label = 'id') { if (!safeId(id)) throw new TypeError(`Invalid ${label}`); return id; }
  _projectPath(id) { return path.join(this.projectsDir, `${this._id(id, 'project id')}.json`); }
  _snapshotPath(id) { return path.join(this.snapshotsDir, `${this._id(id, 'snapshot id')}.json`); }
  async _readJson(file) { await this.ready; return JSON.parse(await readFile(file, 'utf8')); }
  async _writeAtomic(file, data) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  }
  async _withProcessLock(projectId, fn) {
    await this.ready;
    const lockPath = path.join(this.locksDir, `${this._id(projectId, 'project id')}.lock`);
    // Hold a kernel advisory lock for the whole read/check/write transaction. The child
    // exits on parent death, so abandoned locks recover automatically without unsafe
    // age-based reclamation or rename races between competing reclaimers.
    const child = spawn('flock', ['-x', '-w', '30', lockPath, process.execPath, '-e', "process.stdout.write('LOCKED\\n'); process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    let stdout = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
    let exited = false, exitCode;
    const exitPromise = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { exited = true; exitCode = code; resolve({ code, signal }); });
    });
    try {
      // The holder prints only after flock acquired and exec started.
      await new Promise((resolve, reject) => {
        const onData = () => { if (stdout.includes('LOCKED\n')) { child.stdout.off('data', onData); resolve(); } };
        child.stdout.on('data', onData);
        exitPromise.then(result => { child.stdout.off('data', onData); reject(Object.assign(new Error(`Unable to acquire project lock ${projectId}: ${stderr || result.code}`), { code: result.code === 1 ? 'PROJECT_LOCK_TIMEOUT' : 'PROJECT_LOCK_ERROR' })); }, reject);
        onData();
      });
      if (exited) throw Object.assign(new Error(`Unable to acquire project lock ${projectId}: ${stderr || exitCode}`), { code: exitCode === 1 ? 'PROJECT_LOCK_TIMEOUT' : 'PROJECT_LOCK_ERROR' });
      return await fn();
    } finally {
      if (!exited) { child.stdin.end(); await exitPromise.catch(() => {}); }
    }
  }
  async _project(id) { try { return await this._readJson(this._projectPath(id)); } catch (e) { if (e.code === 'ENOENT') throw new Error(`Project not found: ${id}`); throw e; } }
  async _snapshot(id) { try { return await this._readJson(this._snapshotPath(id)); } catch (e) { if (e.code === 'ENOENT') throw new Error(`Snapshot not found: ${id}`); throw e; } }
  _newId(prefix) { return `${prefix}_${randomUUID().replaceAll('-', '')}`; }
  async _makeSnapshot(projectId, parentSnapshotId, view, localDelta) {
    const id = this._newId('snap');
    const snapshot = { ...clone(view), id, projectId, parentSnapshotId: parentSnapshotId ?? null, createdAt: new Date().toISOString(), localDelta: clone(localDelta ?? {}) };
    await this._writeAtomic(this._snapshotPath(id), snapshot);
    return snapshot;
  }
  async createProject(name) {
    await this.ready;
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('Project name is required');
    const id = this._newId('proj');
    const project = { id, name: name.trim(), parentProjectId: null, pinnedParentSnapshotId: null, headSnapshotId: null, createdAt: new Date().toISOString() };
    const snap = await this._makeSnapshot(id, null, { sources: [], procedures: [], records: [], policy: {}, coverage: [], entityReconciliations: [] }, {});
    project.headSnapshotId = snap.id;
    await this._writeAtomic(this._projectPath(id), project);
    return { ...project, snapshot: snap };
  }
  async listProjects() {
    await this.ready;
    const files = (await readdir(this.projectsDir)).filter(x => x.endsWith('.json'));
    return Promise.all(files.map(f => this._readJson(path.join(this.projectsDir, f))));
  }
  async getProject(id) { return this._project(id); }
  async getSnapshot(projectId, snapshotId) {
    const project = await this._project(projectId);
    const snap = await this._snapshot(snapshotId ?? project.headSnapshotId);
    if (snap.projectId !== projectId) throw new Error('Snapshot does not belong to project');
    return clone(snap);
  }
  async forkProject(parentId, snapshotId, name) {
    const parentProject = await this._project(parentId);
    const pinnedId = snapshotId ?? parentProject.headSnapshotId;
    const parent = await this._snapshot(pinnedId);
    if (parent.projectId !== parentId) throw new Error('Parent snapshot does not belong to parent project');
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('Project name is required');
    const id = this._newId('proj');
    const project = { id, name: name.trim(), parentProjectId: parentId, pinnedParentSnapshotId: pinnedId, headSnapshotId: null, createdAt: new Date().toISOString() };
    const snap = await this._makeSnapshot(id, pinnedId, parent, {});
    project.headSnapshotId = snap.id;
    await this._writeAtomic(this._projectPath(id), project);
    return { ...project, snapshot: snap };
  }
  async getAncestry(projectId) {
    const chain = []; let project = await this._project(projectId), snapshot = await this._snapshot(project.headSnapshotId);
    chain.push({ projectId: project.id, name: project.name, snapshotId: snapshot.id, pinnedParentSnapshotId: snapshot.parentSnapshotId });
    while (snapshot.parentSnapshotId) {
      snapshot = await this._snapshot(snapshot.parentSnapshotId);
      project = await this._project(snapshot.projectId);
      chain.push({ projectId: project.id, name: project.name, snapshotId: snapshot.id, pinnedParentSnapshotId: snapshot.parentSnapshotId });
    }
    return chain;
  }
  async diffProject(projectId) {
    const project = await this._project(projectId), snap = await this.getSnapshot(projectId);
    return { projectId, snapshotId: snap.id, parentSnapshotId: snap.parentSnapshotId, ...clone(snap.localDelta ?? {}) };
  }
  async exportProject(projectId, snapshotId) {
    const snap = await this.getSnapshot(projectId, snapshotId);
    return { format: 'skr-project-export-v1', exportedAt: new Date().toISOString(), snapshot: snap };
  }
  async _serialize(projectId, expectedSnapshotId, changes, createSnapshot = true) {
    const project = await this._project(projectId);
    if (project.headSnapshotId !== expectedSnapshotId) {
      const err = new Error(`Snapshot conflict: expected ${expectedSnapshotId}, current head is ${project.headSnapshotId}`);
      err.code = 'SNAPSHOT_CONFLICT'; throw err;
    }
    const old = await this._snapshot(expectedSnapshotId);
    const next = clone(old);
    const delta = { sources: [], records: [], procedures: [], overrides: {}, coverage: [] };
    const addOrReplace = (arr, incoming, key) => {
      if (!Array.isArray(incoming)) throw new TypeError(`${key} must be an array`);
      for (const rawItem of incoming) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) throw new TypeError(`Invalid ${key} item`);
        const item = key === 'coverage' && !rawItem.id ? { ...rawItem, id: `coverage_${hash(Buffer.from(JSON.stringify(rawItem))).slice(0, 24)}` } : rawItem;
        if (!safeId(item.id)) throw new TypeError(`Invalid ${key} id`);
        const index = arr.findIndex(x => key === 'sources' ? (x.sourceId ?? x.id) === (item.sourceId ?? item.id) : key === 'procedures' ? x.id === item.id && x.version === item.version : x.id === item.id);
        if (key === 'procedures' && index >= 0) {
          const stripActivation = x => { const { active, lifecycle, validation, activation, ...rest } = x; return rest; };
          if (JSON.stringify(stripActivation(arr[index])) !== JSON.stringify(stripActivation(item))) throw new Error(`Procedure version is immutable: ${item.id}@${item.version}`);
          const wasActive=arr[index].active!==false, becomesActive=item.active===true;
          if (becomesActive&&!wasActive && !(item.lifecycle==='current'&&item.validation==='manager-approved'&&item.activation?.state==='manager-approved'&&typeof item.activation?.reviewedBy==='string'&&item.activation.reviewedBy.trim())) throw new Error(`Activating procedure ${item.id}@${item.version} requires trusted manager approval metadata`);
          if (wasActive&&!becomesActive && item.active===false) throw new Error(`Active procedure ${item.id}@${item.version} cannot be deactivated without activating another approved version`);
        }
        const firstVersion = key==='procedures' && !arr.some(x=>x.id===item.id);
        const defaultActive=key==='procedures'?(index>=0?arr[index].active!==false:firstVersion):undefined;
        const value = key === 'procedures' && item.active === undefined ? { ...item, active: defaultActive } : item;
        if (key === 'procedures' && value.active === true) for (const existing of arr) if (existing.id === item.id && existing.version !== item.version) existing.active = false;
        if (index < 0) arr.push(clone(value)); else arr[index] = clone(value);
      }
    };
    const changeset = clone(changes ?? {});
    addOrReplace(next.sources, changeset.sources ?? [], 'sources'); delta.sources = clone(changeset.sources ?? []);
    addOrReplace(next.records, changeset.records ?? [], 'records'); delta.records = clone(changeset.records ?? []);
    addOrReplace(next.procedures, changeset.procedures ?? [], 'procedures'); delta.procedures = clone(changeset.procedures ?? []);
    changeset.coverage = (changeset.coverage ?? []).map(item => item.id ? item : { ...item, id: `coverage_${hash(Buffer.from(JSON.stringify(item))).slice(0, 24)}` });
    addOrReplace(next.coverage ??= [], changeset.coverage, 'coverage'); delta.coverage = clone(changeset.coverage);
    if (changeset.policy !== undefined) {
      if (!changeset.policy || typeof changeset.policy !== 'object' || Array.isArray(changeset.policy)) throw new TypeError('policy must be an object');
      next.policy = { ...next.policy, ...clone(changeset.policy) };
      delta.policy = clone(changeset.policy);
    }
    if (changeset.overrides !== undefined) {
      if (!changeset.overrides || typeof changeset.overrides !== 'object' || Array.isArray(changeset.overrides)) throw new TypeError('overrides must be an object');
      next.overrides = { ...next.overrides, ...clone(changeset.overrides) };
      delta.overrides = clone(changeset.overrides);
    }
    if (changeset.entityReconciliations !== undefined) {
      if (!Array.isArray(changeset.entityReconciliations)) throw new TypeError('entityReconciliations must be an array');
      next.entityReconciliations ??= [];
      for (const event of changeset.entityReconciliations) {
        if (!event || !safeId(event.eventId) || typeof event.operationId !== 'string') throw new TypeError('Invalid entity reconciliation event');
        if (next.entityReconciliations.some(x => x.eventId === event.eventId)) throw new Error('Duplicate entity reconciliation event');
        next.entityReconciliations.push(clone(event));
      }
      delta.entityReconciliations = clone(changeset.entityReconciliations);
    }
    this._invalidate(old, next, changeset);
    if (!createSnapshot) return { project, old, next, delta };
    const oldDelta = old.localDelta ?? {};
    const mergeDelta = (key, items, match) => {
      const result = clone(oldDelta[key] ?? []);
      for (const item of items) { const i = result.findIndex(x => match(x, item)); if (i < 0) result.push(clone(item)); else result[i] = clone(item); }
      return result;
    };
    delta.sources = mergeDelta('sources', delta.sources, (a,b) => (a.sourceId ?? a.id) === (b.sourceId ?? b.id));
    delta.records = mergeDelta('records', delta.records, (a,b) => a.id === b.id);
    delta.procedures = mergeDelta('procedures', delta.procedures, (a,b) => a.id === b.id && a.version === b.version);
    // Keep local override activity aligned with the effective merged view after successive local versions.
    for (const lp of delta.procedures) lp.active = next.procedures.find(p => p.id === lp.id && p.version === lp.version)?.active ?? false;
    delta.coverage = mergeDelta('coverage', delta.coverage, (a,b) => a.id === b.id);
    delta.policy = { ...(oldDelta.policy ?? {}), ...(delta.policy ?? {}) };
    delta.overrides = { ...(oldDelta.overrides ?? {}), ...(delta.overrides ?? {}) };
    delta.entityReconciliations = [...(oldDelta.entityReconciliations ?? []), ...(delta.entityReconciliations ?? [])];
    const snap = await this._makeSnapshot(projectId, old.parentSnapshotId, next, delta);
    // The only mutable project pointer is atomically replaced after all validation and snapshot persistence.
    project.headSnapshotId = snap.id;
    await this._writeAtomic(this._projectPath(projectId), project);
    return snap;
  }
  _invalidate(old, next, changes) {
    const oldRecords = new Map(old.records.map(r => [r.id, JSON.stringify(r)]));
    const changedRecordIds = new Set(next.records.filter(r => oldRecords.has(r.id) && oldRecords.get(r.id) !== JSON.stringify(r)).map(r => r.id));
    const oldSourceById = new Map(old.sources.map(s => [s.sourceId ?? s.id, s]));
    const changedSourceVersions = new Set();
    for (const s of changes.sources ?? []) {
      const previous = oldSourceById.get(s.sourceId ?? s.id);
      if (previous && previous.id !== s.id) changedSourceVersions.add(previous.id);
    }
    const oldProc = new Map(old.procedures.map(p => [`${p.id}@${p.version}`, p]));
    const oldActive = new Map(old.procedures.filter(p => p.active !== false).map(p => [p.id, p.version]));
    const newActive = new Map(next.procedures.filter(p => p.active !== false).map(p => [p.id, p.version]));
    const changedProcedures = new Set([...oldActive].filter(([id, v]) => newActive.has(id) && newActive.get(id) !== v).map(([id]) => id));
    const stale = new Set();
    for (const r of next.records) {
      if (r.lifecycle === 'stale') { stale.add(r.id); continue; }
      const depStale = (r.dependencies ?? []).some(d => changedSourceVersions.has(d) || changedRecordIds.has(d) || stale.has(d));
      const sourceStale = changedSourceVersions.has(r.sourceVersionId);
      const oldProcVersion = changedProcedures.has(r.procedureId) && newActive.get(r.procedureId) !== r.procedureVersion;
      if (depStale || sourceStale || oldProcVersion) { r.lifecycle = 'stale'; r.staleReason = depStale ? 'dependency-invalidated' : sourceStale ? 'source-version-updated' : 'procedure-version-updated'; stale.add(r.id); }
    }
    // Repeat to fixed point in case records are not topologically ordered.
    let changed = true;
    while (changed) { changed = false; for (const r of next.records) if (r.lifecycle !== 'stale' && (r.dependencies ?? []).some(d => stale.has(d))) { r.lifecycle = 'stale'; r.staleReason = 'dependency-invalidated'; stale.add(r.id); changed = true; } }
  }
  async commit(projectId, expectedSnapshotId, changeSet) {
    // Serialize in-process writers, and still recheck under the lock before mutating the head.
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let release; const held = new Promise(resolve => { release = resolve; }); const tail = previous.then(() => held); this.locks.set(projectId, tail);
    await previous;
    try { return await this._withProcessLock(projectId, () => this._serialize(projectId, expectedSnapshotId, changeSet)); }
    finally { release(); if (this.locks.get(projectId) === tail) this.locks.delete(projectId); }
  }
  /** Activate one exact inactive draft through an audited manager decision. */
  async approveProcedure(projectId, expectedSnapshotId, { id, version, reviewedBy } = {}) {
    if(typeof reviewedBy!=='string'||!reviewedBy.trim())throw new TypeError('An authenticated reviewer identity is required');
    const snapshot=await this.getSnapshot(projectId,expectedSnapshotId);
    const draft=snapshot.procedures.find(p=>p.id===id&&String(p.version)===String(version));
    if(!draft)throw new Error(`Procedure ${id}@${version} is not pinned`);
    if(draft.active!==false||draft.lifecycle!=='draft'||draft.validation!=='unreviewed')throw new Error('Only an inactive unreviewed procedure draft can be approved');
    const approved={...draft,active:true,lifecycle:'current',validation:'manager-approved',activation:{state:'manager-approved',reviewedBy:reviewedBy.trim(),reviewedAt:new Date().toISOString()}};
    return this.commit(projectId,expectedSnapshotId,{procedures:[approved]});
  }
  /** Trusted explicit entity merge. The caller supplies identity IDs, never replacement records. */
  async reconcileEntities(projectId, expectedSnapshotId, { fromEntityId, toEntityId, reviewedBy } = {}) {
    if (typeof reviewedBy !== 'string' || !reviewedBy.trim()) throw new TypeError('An authenticated reviewer identity is required');
    const snapshot = await this.getSnapshot(projectId, expectedSnapshotId);
    if (snapshot.id !== expectedSnapshotId) throw Object.assign(new Error('Snapshot conflict'), { code: 'SNAPSHOT_CONFLICT' });
    const mentions = new Set(snapshot.records.flatMap(r => (r.entityMentions ?? []).map(m => m.entityId)));
    if (!mentions.has(fromEntityId) || !mentions.has(toEntityId)) throw new Error('Both entity IDs must exist in the pinned project snapshot');
    const operationId = `recon_${randomUUID().replaceAll('-', '')}`;
    const plan = planEntityAliases({ records: snapshot.records, fromEntityId, toEntityId, operationId, reviewedBy: reviewedBy.trim() });
    if (!plan.changeSet.records.length) throw new Error('No source assertion uses the selected alias');
    const event = { eventId:operationId, operationId, action:'merge', projectId, baseSnapshotId:expectedSnapshotId, fromEntityId, toEntityId,
      changedRecordIds:plan.changedRecordIds, beforeRecords:plan.undo.records, reviewedBy:reviewedBy.trim(), createdAt:new Date().toISOString() };
    const next = await this.commit(projectId, expectedSnapshotId, { records:plan.changeSet.records, entityReconciliations:[event] });
    return { snapshot:next, operationId, changedRecordIds:plan.changedRecordIds, fromEntityId, toEntityId };
  }
  /** Undo only a merge event issued by this store; prior records come from its pinned journal. */
  async undoEntityReconciliation(projectId, expectedSnapshotId, operationId, { reviewedBy } = {}) {
    if (typeof reviewedBy !== 'string' || !reviewedBy.trim()) throw new TypeError('An authenticated reviewer identity is required');
    const snapshot = await this.getSnapshot(projectId, expectedSnapshotId);
    const events = snapshot.entityReconciliations ?? [];
    const original = events.find(e => e.operationId === operationId && e.action === 'merge' && e.projectId === projectId);
    if (!original) throw new Error('Entity reconciliation is not a merge owned by this project');
    if (events.some(e => e.action === 'undo' && e.undoOf === operationId)) throw new Error('Entity reconciliation was already undone');
    const eventId = `undo_${randomUUID().replaceAll('-', '')}`;
    const event = { eventId, operationId:eventId, action:'undo', undoOf:operationId, projectId, baseSnapshotId:expectedSnapshotId,
      changedRecordIds:original.beforeRecords.map(r=>r.id), reviewedBy:reviewedBy.trim(), createdAt:new Date().toISOString() };
    const next = await this.commit(projectId, expectedSnapshotId, { records:original.beforeRecords, entityReconciliations:[event] });
    return { snapshot:next, operationId:eventId, undoneOperationId:operationId, changedRecordIds:event.changedRecordIds };
  }
  async registerSource(projectId, { name, content, mimeType = 'application/octet-stream', sourceId, expectedSnapshotId } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('Source name is required');
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '');
    const parsed = await readSourceContent({ content: bytes, name, mimeType });
    const actualSourceId = sourceId ?? this._newId('source'); this._id(actualSourceId, 'source id');
    await this.ready;
    const objectPath = path.join(this.objectsDir, parsed.digest.slice(0, 2), parsed.digest);
    try { await access(objectPath); } catch { await mkdir(path.dirname(objectPath), { recursive: true }); await writeFile(objectPath, bytes, { flag: 'wx', mode: 0o600 }).catch(e => { if (e.code !== 'EEXIST') throw e; }); }
    const project = await this._project(projectId), snapshot = await this.getSnapshot(projectId);
    if (expectedSnapshotId && snapshot.id !== expectedSnapshotId) { const err = new Error(`Snapshot conflict: expected ${expectedSnapshotId}, current head is ${snapshot.id}`); err.code = 'SNAPSHOT_CONFLICT'; throw err; }
    const versionId = this._newId('srcv');
    const source = { id: versionId, sourceVersionId: versionId, sourceId: actualSourceId, name: name.trim(), digest: parsed.digest, mimeType, regions: parsed.regions, coverage: parsed.coverage, readerProfile: parsed.readerProfile ?? null, workBoundaries:parsed.workBoundaries??null, createdAt: new Date().toISOString() };
    const next = await this.commit(projectId, snapshot.id, { sources: [source], coverage: [{ id: `coverage_${versionId}`, sourceVersionId: versionId, ...parsed.coverage }] });
    return { source: clone(source), snapshot: next, projectId: project.id };
  }
  async readSource(sourceVersionId) {
    this._id(sourceVersionId, 'source version id');
    await this.ready;
    for (const fileName of await readdir(this.snapshotsDir)) {
      if (!fileName.endsWith('.json')) continue;
      const s = await this._readJson(path.join(this.snapshotsDir, fileName));
      const source = (s.sources ?? []).find(x => x.id === sourceVersionId || x.sourceVersionId === sourceVersionId);
      if (source) {
        const file = path.join(this.objectsDir, source.digest.slice(0, 2), source.digest);
        const bytes = await readFile(file);
        if (hash(bytes) !== source.digest) throw new Error('Source object digest mismatch');
        return bytes;
      }
    }
    throw new Error(`Source version not found: ${sourceVersionId}`);
  }
  async rebaseProject(projectId, newParentSnapshotId) {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let release; const held = new Promise(resolve => { release = resolve; }); const tail = previous.then(() => held); this.locks.set(projectId, tail);
    await previous;
    try { return await this._withProcessLock(projectId, () => this._rebaseProjectLocked(projectId, newParentSnapshotId)); }
    finally { release(); if (this.locks.get(projectId) === tail) this.locks.delete(projectId); }
  }
  async _rebaseProjectLocked(projectId, newParentSnapshotId) {
    const project = await this._project(projectId);
    if (!project.parentProjectId) throw new Error('Root projects cannot be rebased');
    const newParent = await this._snapshot(this._id(newParentSnapshotId, 'snapshot id'));
    if (newParent.projectId !== project.parentProjectId) throw new Error('New parent snapshot belongs to another project');
    const child = await this.getSnapshot(projectId);
    const oldParent = await this._snapshot(project.pinnedParentSnapshotId);
    const childLocal = child.localDelta ?? {};
    // An inactive local draft composes with a parent's active update. Only a separately
    // activated local override conflicts when both branches changed the active version.
    for(const proc of childLocal.procedures??[])if(proc.active!==false){
      const previousActive=oldParent.procedures.find(p=>p.id===proc.id&&p.active!==false),incomingActive=newParent.procedures.find(p=>p.id===proc.id&&p.active!==false);
      if(previousActive&&incomingActive&&previousActive.version!==incomingActive.version&&proc.version!==incomingActive.version)throw new Error(`Rebase conflict: local active procedure ${proc.id}@${proc.version} conflicts with parent ${incomingActive.version}`);
    }
    for (const record of child.records) {
      if (record.lifecycle === 'stale') continue;
      if (record.procedureId && record.procedureVersion) {
        const exists = newParent.procedures.some(p => p.id === record.procedureId && p.version === record.procedureVersion) || child.procedures.some(p => p.id === record.procedureId && p.version === record.procedureVersion);
        if (!exists) { record.lifecycle = 'stale'; record.staleReason = 'rebase-procedure-unavailable'; }
      }
      if ((record.dependencies ?? []).some(d => !child.records.some(r => r.id === d) && !newParent.records.some(r => r.id === d) && !child.sources.some(s => s.id === d) && !newParent.sources.some(s => s.id === d))) { record.lifecycle = 'stale'; record.staleReason = 'rebase-dependency-unavailable'; }
    }
    const localSources = childLocal.sources ?? [], localRecords = childLocal.records ?? [], localProcedures = childLocal.procedures ?? [];
    const localSourceIds = new Set(localSources.map(s => s.sourceId ?? s.id));
    const localRecordIds = new Set(localRecords.map(r => r.id));
    const mergedProcedures=clone(newParent.procedures);
    for(const proc of localProcedures){
      const index=mergedProcedures.findIndex(p=>p.id===proc.id&&String(p.version)===String(proc.version));
      if(index>=0){
        const definition=x=>{const{active,lifecycle,validation,activation,review,...rest}=x;return rest;};
        if(JSON.stringify(definition(mergedProcedures[index]))!==JSON.stringify(definition(proc)))throw new Error(`Rebase conflict: procedure version ${proc.id}@${proc.version} has competing definitions`);
        if(mergedProcedures[index].active===true)continue; // Preserve an upstream manager-approved activation.
      }
      if(proc.active!==false)for(const p of mergedProcedures)if(p.id===proc.id&&String(p.version)!==String(proc.version))p.active=false;
      if(index<0)mergedProcedures.push(clone(proc));else mergedProcedures[index]=clone(proc);
    }
    const merged = { ...clone(newParent), sources: [...newParent.sources.filter(s => !localSourceIds.has(s.sourceId ?? s.id)), ...localSources], records: [...newParent.records.filter(r => !localRecordIds.has(r.id)), ...localRecords], procedures: mergedProcedures, policy: { ...newParent.policy, ...(childLocal.policy ?? {}) }, coverage: [...(newParent.coverage ?? []), ...(childLocal.coverage ?? [])], overrides: { ...(newParent.overrides ?? {}), ...(childLocal.overrides ?? {}) }, entityReconciliations: [...(newParent.entityReconciliations ?? []), ...(childLocal.entityReconciliations ?? [])] };
    const localRecordById = new Map((childLocal.records ?? []).map(r => [r.id, child.records.find(x => x.id === r.id) ?? r]));
    merged.records = [...merged.records.filter(r => !localRecordIds.has(r.id)), ...localRecordById.values()];
    // Mark local materializations stale when the pinned parent's source or procedure changed.
    const oldSources = new Map(oldParent.sources.map(s => [s.sourceId ?? s.id, s.id]));
    const newSources = new Map(newParent.sources.map(s => [s.sourceId ?? s.id, s.id]));
    const changedVersions = new Set([...oldSources].filter(([id, version]) => newSources.has(id) && newSources.get(id) !== version).map(([,version]) => version));
    const oldProcedures = new Map(oldParent.procedures.filter(p => p.active !== false).map(p => [p.id, p.version]));
    const newProcedures = new Map(newParent.procedures.filter(p => p.active !== false).map(p => [p.id, p.version]));
    const changedProcedureIds = new Set([...oldProcedures].filter(([id,v]) => newProcedures.has(id) && newProcedures.get(id) !== v).map(([id]) => id));
    const staleIds = new Set();
    for (const r of merged.records) {
      if ((r.dependencies ?? []).some(d => changedVersions.has(d)) || changedVersions.has(r.sourceVersionId) || (changedProcedureIds.has(r.procedureId) && newProcedures.get(r.procedureId) !== r.procedureVersion)) {
        r.lifecycle = 'stale'; r.staleReason = 'rebase-parent-version-changed'; staleIds.add(r.id);
      }
    }
    let propagated = true;
    while (propagated) { propagated = false; for (const r of merged.records) if (r.lifecycle !== 'stale' && (r.dependencies ?? []).some(d => staleIds.has(d))) { r.lifecycle = 'stale'; r.staleReason = 'dependency-invalidated'; staleIds.add(r.id); propagated = true; } }
    const rebasedDelta = { ...clone(childLocal), records: [...localRecordById.values()] };
    for (const lp of rebasedDelta.procedures ?? []) lp.active = merged.procedures.find(p => p.id === lp.id && p.version === lp.version)?.active ?? false;
    const snap = await this._makeSnapshot(projectId, newParentSnapshotId, merged, rebasedDelta);
    project.pinnedParentSnapshotId = newParentSnapshotId; project.headSnapshotId = snap.id;
    await this._writeAtomic(this._projectPath(projectId), project);
    return snap;
  }
  async saveRun(run) {
    await this.ready;
    if (!run || !safeId(run.id)) throw new TypeError('Run requires safe id');
    if (run.projectId) await this._project(run.projectId);
    await this._writeAtomic(path.join(this.runsDir, `${run.id}.json`), run);
    return clone(run);
  }
  async getRun(id) { this._id(id, 'run id'); return this._readJson(path.join(this.runsDir, `${id}.json`)); }
  async listRuns(projectId) {
    await this._project(projectId);
    return (await readdir(this.runsDir)).filter(f => f.endsWith('.json')).map(f => path.join(this.runsDir, f)).reduce(async (acc, f) => { const out = await acc; const r = await this._readJson(f); if (r.projectId === projectId) out.push(r); return out; }, Promise.resolve([]));
  }
}
