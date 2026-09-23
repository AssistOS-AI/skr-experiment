import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir,'..');
const manifest = JSON.parse(await readFile(join(root,'corpora/books/manifest.json'),'utf8'));
for (const book of manifest.books) {
  const path = join(root,'corpora/books',book.file);
  let bytes;
  try { bytes = await readFile(path); }
  catch {
    const response = await fetch(book.downloadUrl, { headers: { 'User-Agent':'SKR research corpus builder; contact: research prototype' } });
    if (!response.ok) throw new Error(`Download failed ${book.downloadUrl}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(path,bytes);
  }
  const digest=createHash('sha256').update(bytes).digest('hex');
  if (digest !== book.sha256) throw new Error(`${book.id} checksum mismatch: expected ${book.sha256}, got ${digest}`);
  const text=bytes.toString('utf8');
  if (!text.includes('START OF THE PROJECT GUTENBERG EBOOK') || !text.includes('END OF THE PROJECT GUTENBERG EBOOK')) throw new Error(`${book.id} missing complete-work boundary markers`);
  console.log(`${book.id}\t${digest}\t${bytes.length} bytes\tcomplete markers verified`);
}
