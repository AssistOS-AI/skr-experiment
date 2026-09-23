import { buildBookSnapshot } from '../src/evaluation/book-snapshot-builder.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const result = await buildBookSnapshot({
  manifestPath: option('manifest') ?? 'corpora/books/manifest.json',
  outputPath: option('out') ?? 'artifacts/research/public-books-snapshot.json',
  storeDir: option('store-dir') ?? 'artifacts/public-books-store',
  sessionWorkspace: option('session-workspace'),
  checkpointDir: option('checkpoint-dir'),
  books: option('books') ?? 'all',
  ingest: process.argv.includes('--ingest'),
});
console.log(JSON.stringify(result.summary, null, 2));
