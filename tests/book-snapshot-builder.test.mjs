import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ProjectStore } from '../src/store.mjs';
import { buildBookSnapshot } from '../src/evaluation/book-snapshot-builder.mjs';
import { validateChangeSet } from '../src/runtime/change-validation.mjs';

const execFileAsync = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function makeManifest(root) {
  const bytes = Buffer.from('*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\nA small source fact.\n*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\n');
  await writeFile(join(root, 'book.txt'), bytes);
  const manifest = { corpusId: 'test-corpus-v1', books: [{ id: 'pg-test', title: 'Test Book', author: 'A. Writer', file: 'book.txt', sha256: digest(bytes) }] };
  const manifestPath = join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

test('book snapshot CLI verifies manifest hashes and persists a no-ingest snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skr-book-builder-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = await makeManifest(root), outputPath = join(root, 'snapshot.json'), storeDir = join(root, 'store');
  await execFileAsync(process.execPath, ['scripts/build-book-snapshot.mjs', `--manifest=${manifestPath}`, '--books=pg-test', `--out=${outputPath}`, `--store-dir=${storeDir}`], { cwd: process.cwd() });
  const artifact = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(artifact.provenance.corpusId, 'test-corpus-v1');
  assert.equal(artifact.provenance.ingestion, null);
  assert.equal(artifact.provenance.sourceDigestsVerified, true);
  assert.equal(artifact.snapshot.sources.length, 1);
  assert.equal(artifact.snapshot.sources[0].sourceId, 'pg-test');
  assert.equal(artifact.snapshot.procedures.length, 3);
  const reopened = await new ProjectStore({ rootDir: storeDir }).getSnapshot(artifact.snapshot.projectId);
  assert.equal(reopened.id, artifact.snapshot.id);
  assert.equal(reopened.sources[0].digest, digest(await readFile(join(root, 'book.txt'))));
});

test('book snapshot preparation refuses bytes whose checksum differs from the manifest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skr-book-builder-checksum-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = await makeManifest(root), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.books[0].sha256 = '0'.repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(buildBookSnapshot({ manifestPath, outputPath: join(root, 'out.json'), storeDir: join(root, 'store'), books: ['pg-test'] }), /do not match manifest SHA-256/);
});

test('book snapshot preparation resumes the same project, source pin, session and checkpoint after interruption', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skr-book-builder-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = await makeManifest(root), storeDir = join(root, 'store'), checkpointDir = join(root, 'checkpoint');
  const calls = [], sessions = [], sessionPins = new Map();
  let attempts = 0, validations = 0;
  const ingestFn = async options => {
    calls.push({ snapshotId: options.snapshot.id, checkpointDir: options.checkpointDir, scope: options.sourceScope });
    if (attempts++ === 0) throw new Error('simulated interruption');
    return { validation: { status: 'model-reviewed' }, changeSet: { records: [], coverage: [] }, evidence: [], reviewReceipts: [], coverage: { regions: 1, incompleteRegions: 0 } };
  };
  const build = () => buildBookSnapshot({ manifestPath, outputPath: join(root, 'out.json'), storeDir, checkpointDir, books: ['pg-test'], ingest: true,
    sessionFactory: options => { sessions.push(options); let state=sessionPins.get(options.isolation.sessionDir); if(!state){state={sessionId:'mock-session-stable',requests:2,totalUsage:{input_tokens:31,output_tokens:9}};sessionPins.set(options.isolation.sessionDir,state);} return {async status(){return state;}}; },
    ingestFn, validate: options => { validations++; return validateChangeSet(options); } });
  await assert.rejects(build(), /simulated interruption/);
  const firstRecovery = JSON.parse(await readFile(join(checkpointDir, 'builder-recovery.json'), 'utf8'));
  const second = await build();
  assert.equal(calls.length, 2);
  assert.equal(validations, 1);
  assert.equal(calls[0].snapshotId, calls[1].snapshotId);
  assert.equal(calls[0].checkpointDir, calls[1].checkpointDir);
  assert.deepEqual(calls[1].scope, calls[0].scope);
  assert.equal(sessions.length, 2, 'a fresh session adapter is created for the resumed invocation');
  assert.equal(sessions[0].isolation.sessionDir, sessions[1].isolation.sessionDir);
  assert.equal(sessions[0].workspaceDir, sessions[1].workspaceDir);
  assert.equal(firstRecovery.projectId, second.projectId);
  assert.equal(firstRecovery.sessionId, 'mock-session-stable');
  assert.equal(second.provenance.ingestion.sessionId, 'mock-session-stable');
  assert.deepEqual(second.provenance.ingestion.usage, { input_tokens: 31, output_tokens: 9 });
  const reopened = await new ProjectStore({ rootDir: storeDir }).getSnapshot(second.projectId);
  assert.equal(reopened.id, second.snapshot.id);
  assert.equal(reopened.sources.length, 1);
  assert.equal(reopened.records.length, 0);
  const repeated = await build();
  assert.equal(repeated.summary.reusedCompletedIngestion, true);
  assert.equal(sessions.length, 2, 'completed ingestion is reused without starting a new Luna session');
  assert.equal(calls.length, 2);
});
