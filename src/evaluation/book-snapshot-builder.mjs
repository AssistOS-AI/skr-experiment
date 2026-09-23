import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../store.mjs';
import { builtinProcedures } from '../engine/index.mjs';
import { ingestProject } from '../ingestion/index.mjs';
import { CodexLunaSession } from '../runtime/session.mjs';
import { validateChangeSet } from '../runtime/change-validation.mjs';
import { preparePinnedIngestionWorkspace } from '../runtime/session-workspace.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Build or resume a persistent, checksum-pinned public-book project. Dependencies are
 * injectable for offline recovery tests; production defaults always use Codex Luna. */
export async function buildBookSnapshot({
  manifestPath = 'corpora/books/manifest.json',
  outputPath = 'artifacts/research/public-books-snapshot.json',
  storeDir = 'artifacts/public-books-store',
  sessionWorkspace,
  checkpointDir,
  books = 'all',
  ingest = false,
  store: suppliedStore,
  sessionFactory = options => new CodexLunaSession(options),
  ingestFn = ingestProject,
  validate = validateChangeSet,
  procedures = builtinProcedures(),
} = {}) {
  const manifestFile = resolve(manifestPath);
  const manifestBytes = await readFile(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const selected = new Set(Array.isArray(books) ? books : String(books).split(',').filter(Boolean));
  const selectedBooks = selected.has('all') ? manifest.books : manifest.books.filter(book => selected.has(book.id));
  if (!selectedBooks.length || (!selected.has('all') && selectedBooks.length !== selected.size)) {
    throw new Error('Requested book IDs must all exist in the pinned corpus manifest');
  }
  const corpusId = manifest.corpusId ?? manifest.id ?? 'public-books';
  const bookKey = selectedBooks.map(book => book.id).sort().join('_');
  const projectName = `Pinned public books ${corpusId} ${bookKey}`;
  const outputFile = resolve(outputPath);
  const store = suppliedStore ?? new ProjectStore({ rootDir: resolve(storeDir) });
  await mkdir(workspacePath, { recursive: true });

  const manifestSha = sha256(manifestBytes);
  let project = (await store.listProjects()).find(item => item.name === projectName);
  if (!project) project = await store.createProject(projectName);
  let snapshot = await store.getSnapshot(project.id);
  const activeProcedures = procedures.map(procedure => ({ ...structuredClone(procedure), active: true, lifecycle: 'current', validation: 'manager-approved' }));
  if (activeProcedures.some(definition => !snapshot.procedures?.some(p => p.id === definition.id && String(p.version) === String(definition.version)))) {
    snapshot = await store.commit(project.id, snapshot.id, { procedures: activeProcedures });
  }

  const corpusRoot = dirname(manifestFile);
  for (const book of selectedBooks) {
    const bytes = await readFile(resolve(corpusRoot, book.file ?? book.path));
    const digest = sha256(bytes);
    if (digest !== book.sha256) throw new Error(`Pinned bytes for ${book.id} do not match manifest SHA-256`);
    const prior = snapshot.sources.find(source => source.sourceId === book.id);
    if (prior?.digest === digest) continue;
    const registered = await store.registerSource(project.id, {
      name: `${book.id}-${book.title}.txt`, content: bytes, mimeType: 'text/plain', sourceId: book.id, expectedSnapshotId: snapshot.id,
    });
    snapshot = registered.snapshot;
  }

  const inputSnapshotId = snapshot.id;
  const pinKey = sha256(`${resolve(storeDir)}\0${project.id}\0${manifestSha}\0${bookKey}`).slice(0, 24);
  const checkpointRoot = resolve(checkpointDir ?? `artifacts/book-ingestion-checkpoints/${project.id}/${pinKey}`);
  const checkpointPath = resolve(checkpointRoot, 'runs', inputSnapshotId);
  const workspacePath = resolve(sessionWorkspace ?? `${tmpdir()}/skr-public-books-luna-${project.id}-${inputSnapshotId}`);
  const completionPath = resolve(checkpointRoot, 'builder-complete.json');

  let completed = null;
  try { completed = JSON.parse(await readFile(completionPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (ingest && completed?.manifestSha256 === manifestSha && completed?.projectId === project.id
      && completed?.snapshotId === snapshot.id && JSON.stringify(completed?.sourceVersions) === JSON.stringify(snapshot.sources.map(source => source.sourceVersionId))) {
    const exported = await store.getSnapshot(project.id, snapshot.id);
    const provenance = completed.provenance;
    const output = { snapshot: exported, provenance };
    await writeSnapshotExport(outputFile, output);
    return {
      output: outputFile, projectId: project.id, snapshot: exported, provenance,
      summary: { status: 'snapshot-ready', output: outputFile, snapshotId: exported.id,
        sourceCount: exported.sources.length, recordCount: exported.records.length, procedureCount: exported.procedures.length,
        ingestionStatus: provenance.ingestion?.status ?? 'not-run', reusedCompletedIngestion: true,
        sourceVersions: exported.sources.map(source => ({ sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, digest: source.digest, regions: source.regions.length })) },
    };
  }

  let ingestion = null, session = null, usage = null, requestCount = null, sessionId = null;
  if (ingest) {
    const pinned = await preparePinnedIngestionWorkspace({ workspaceDir: workspacePath, sessionDir: resolve(dirname(workspacePath), 'sessions', project.id, inputSnapshotId),
      snapshot, sourceScope: snapshot.sources.map(source => source.sourceVersionId), readSource: sourceVersionId => store.readSource(sourceVersionId),
      request: { runId: `ingest_${inputSnapshotId}`, taskType: 'INGEST_SOURCE', text: 'Ingest the selected complete sources, review extracted assertions, and run context synthesis.', sourceScope: snapshot.sources.map(source => source.sourceVersionId), snapshotId: inputSnapshotId, parameters: {} } });
    session = sessionFactory({ workspaceDir: workspacePath, isolation: { enabled: true, bwrapPath: '/usr/bin/bwrap', sessionDir: pinned.sessionDir, skillsDir: pinned.skillsDir } });
    try {
      ingestion = await ingestFn({ snapshot, sourceScope: snapshot.sources.map(source => source.sourceVersionId), session, checkpointDir: checkpointPath, procedures: snapshot.procedures });
    } catch (error) {
      // Persist a private, non-secret recovery marker. The Luna session and ingestion
      // checkpoint remain at their stable paths so a later invocation resumes in place.
      const status = await session.status?.().catch(() => null);
      await mkdir(checkpointPath, { recursive: true });
      await writeFile(resolve(checkpointPath, 'builder-recovery.json'), JSON.stringify({
        corpusId, manifestSha256: manifestSha, pinnedDigest: pinned.pinnedDigest, projectId: project.id, snapshotId: inputSnapshotId,
        sessionId: status?.sessionId ?? null, interruptedAt: new Date().toISOString(), errorName: error?.name ?? 'Error',
      }, null, 2) + '\n', { mode: 0o600 });
      throw error;
    }
    const validated = validate({
      changeSet: ingestion.changeSet, taskType: 'INGEST_SOURCE', snapshot,
      sourceScope: snapshot.sources.map(source => source.sourceVersionId),
      evidence: ingestion.evidence ?? [], reviewReceipts: ingestion.reviewReceipts ?? [],
    });
    if (ingestion.validation?.status === 'model-reviewed' && (validated.records.length || validated.coverage.length)) {
      snapshot = await store.commit(project.id, snapshot.id, { records: validated.records, coverage: validated.coverage });
    }
    const status = await session.status?.();
    usage = status?.totalUsage ?? ingestion.usage ?? null;
    requestCount = status?.requests ?? ingestion.validation?.calls ?? null;
    sessionId = status?.sessionId ?? ingestion.validation?.sessionId ?? null;
  }

  const exported = await store.getSnapshot(project.id, snapshot.id);
  const provenance = {
    corpusId, manifestSha256: manifestSha,
    books: selectedBooks.map(book => ({ bookId: book.id, title: book.title, author: book.author, url: book.sourceUrl, sha256: book.sha256 })),
    sourceDigestsVerified: true, registeredAt: new Date().toISOString(),
    ingestion: ingestion ? {
      status: ingestion.validation?.status, model: 'gpt-6-luna', sessionId, usage, requests: requestCount,
      coverage: ingestion.coverage ?? null, recordCount: ingestion.changeSet?.records?.length ?? 0,
      reviewReceiptCount: ingestion.reviewReceipts?.length ?? 0, checkpoint: ingestion.checkpoint ?? checkpointPath,
      validatedPublication: ingestion.validation?.status === 'model-reviewed',
    } : null,
  };
  if (ingestion) {
    await mkdir(checkpointRoot, { recursive: true });
    await writeFile(completionPath, JSON.stringify({ manifestSha256: manifestSha, projectId: project.id,
      snapshotId: snapshot.id, sourceVersions: snapshot.sources.map(source => source.sourceVersionId), provenance }, null, 2) + '\n', { mode: 0o600 });
  }
  const output = { snapshot: exported, provenance };
  await writeSnapshotExport(outputFile, output);
  return {
    output: outputFile, projectId: project.id, snapshot: exported, provenance,
    summary: { status: 'snapshot-ready', output: outputFile, snapshotId: exported.id,
      sourceCount: exported.sources.length, recordCount: exported.records.length, procedureCount: exported.procedures.length,
      ingestionStatus: provenance.ingestion?.status ?? 'not-run',
      sourceVersions: exported.sources.map(source => ({ sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, digest: source.digest, regions: source.regions.length })) },
  };
}

async function writeSnapshotExport(outputFile, output) {
  await mkdir(dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, outputFile);
}
