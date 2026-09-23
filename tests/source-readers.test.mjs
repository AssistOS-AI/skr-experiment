import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readSourceContent } from '../src/source-readers.mjs';

test('plain text regions have stable distinct line locators', async () => {
  const content = Buffer.from('first\nsecond\n');
  const a = await readSourceContent({ content, name: 'book.txt', mimeType: 'text/plain' });
  const b = await readSourceContent({ content, name: 'book.txt', mimeType: 'text/plain' });
  assert.deepEqual(a.regions.map(r => r.id), b.regions.map(r => r.id));
  assert.equal(new Set(a.regions.map(r => r.id)).size, 2);
  assert.deepEqual(a.regions.map(r => r.locator.line), [1, 2]);
  assert.ok(a.regions.every(r => r.locator.offsetUnit === 'utf16-code-unit'));
  assert.ok(a.regions.every(r => content.toString('utf8').slice(r.locator.start, r.locator.end) === r.text));
});

test('Project Gutenberg work boundary metadata keeps exact narrative lines separate from surrounding legal text', async () => {
  const content=Buffer.from('Title page\n*** START OF THE PROJECT GUTENBERG EBOOK SAMPLE ***\nA narrative line.\n*** END OF THE PROJECT GUTENBERG EBOOK SAMPLE ***\nLicense text.\n');
  const out=await readSourceContent({content,name:'sample.txt',mimeType:'text/plain'});
  assert.equal(out.workBoundaries.type,'project-gutenberg-work-v2');
  assert.deepEqual(out.regions.map(r=>r.sourceSegment),['front-matter','front-matter','work','back-matter','back-matter']);
  assert.deepEqual(out.regions.filter(r=>r.sourceSegment==='work').map(r=>r.text),['A narrative line.']);
  assert.deepEqual(out.regions.filter(r=>r.sourceSegment==='work')[0].locator,{type:'text-line',line:3,start:63,end:80,offsetUnit:'utf16-code-unit'});
  assert.equal(out.regions.length,5);
});

test('text locators preserve original UTF-16 offsets across CRLF, CR, Unicode, and Gutenberg boundaries', async () => {
  const raw = 'Préface 🐇\r\n*** START OF THE PROJECT GUTENBERG EBOOK SAMPLE ***\r\nHéllo 🐰.\r*** END OF THE PROJECT GUTENBERG EBOOK SAMPLE ***\r\nAppendix.\r\n';
  const out = await readSourceContent({ content: Buffer.from(raw), name: 'sample.txt', mimeType: 'text/plain' });
  for (const item of out.regions) {
    assert.equal(item.locator.offsetUnit, 'utf16-code-unit');
    assert.equal(raw.slice(item.locator.start, item.locator.end), item.text);
  }
  assert.equal(out.workBoundaries.offsetUnit, 'utf16-code-unit');
  assert.equal(out.workBoundaries.coordinateBasis, 'original-decoded-source');
  const narrative = out.regions.find(r => r.text === 'Héllo 🐰.');
  assert.equal(narrative.sourceSegment, 'work');
  assert.equal(narrative.locator.start, raw.indexOf('Héllo 🐰.'));
  assert.equal(raw.slice(narrative.locator.start, narrative.locator.end), 'Héllo 🐰.');
  assert.ok(out.regions.filter(r => r.sourceSegment === 'work').every(r => raw.slice(r.locator.start, r.locator.end) === r.text));
});

test('CSV row regions preserve cell locators and JSON errors remain explicit', async () => {
  const csv = await readSourceContent({ content: Buffer.from('name,note\nAda,"likes, tea"\n'), name: 'x.csv', mimeType: 'text/csv' });
  assert.match(csv.regions[0].text, /note: likes, tea/);
  assert.equal(csv.regions[0].locator.row, 2);
  const bad = await readSourceContent({ content: Buffer.from('{bad'), name: 'x.json', mimeType: 'application/json' });
  assert.equal(bad.coverage.status, 'partial');
  assert.match(bad.coverage.deferred[0].reason, /Invalid JSON/);
});

test('unsupported formats are recorded as unreadable instead of fabricated', async () => {
  const out = await readSourceContent({ content: Buffer.from([0, 1, 2]), name: 'x.bin' });
  assert.equal(out.regions.length, 0);
  assert.equal(out.coverage.status, 'unreadable');
});

test('PDF reader preserves text pages and OCRs image-only pages when local tools are available', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skr-ocr-test-'));
  try {
    try {
      execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
      execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
      execFileSync('tesseract', ['--version'], { stdio: 'ignore' });
      execFileSync('convert', ['-version'], { stdio: 'ignore' });
      execFileSync('gs', ['--version'], { stdio: 'ignore' });
    } catch { t.skip('PDF/OCR command line tools are not installed'); return; }
    const ps = path.join(temp, 'text.ps'), textPdf = path.join(temp, 'text.pdf'), scanPng = path.join(temp, 'scan.png'), scanPdf = path.join(temp, 'scan.pdf'), mixed = path.join(temp, 'mixed.pdf');
    await writeFile(ps, '%!PS-Adobe-3.0\n/Helvetica findfont 24 scalefont setfont\n72 700 moveto\n(TEXT PAGE CONTENT) show\nshowpage\n');
    execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', `-sOutputFile=${textPdf}`, ps]);
    execFileSync('convert', ['-size', '600x800', 'xc:white', '-fill', 'black', '-font', 'Helvetica', '-pointsize', '40', '-draw', "text 30,400 'SCAN PAGE LUNA'", scanPng]);
    execFileSync('convert', [scanPng, scanPdf]);
    execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', `-sOutputFile=${mixed}`, textPdf, scanPdf]);
    const result = await readSourceContent({ content: await readFile(mixed), name: 'mixed.pdf', mimeType: 'application/pdf' });
    assert.equal(result.regions.find(r => r.locator.page === 1)?.text, 'TEXT PAGE CONTENT');
    const scanned = result.regions.find(r => r.locator.page === 2);
    assert.match(scanned?.text ?? '', /SCAN PAGE LUNA/);
    assert.equal(scanned.locator.extraction, 'tesseract-eng-130dpi-max2500px-psm3');
    assert.equal(result.readerProfile.ocr.maxRasterPixels, 2500);
    assert.equal(typeof result.readerDiagnostics.ocrElapsedMs, 'number');
    assert.equal('elapsedMs' in result.readerProfile.ocr, false);
    assert.equal(result.readerProfile.pageCount, 2);
    assert.equal(result.coverage.deferred.length, 2);
    assert.ok(result.coverage.deferred.every(x => x.state === 'readable'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('EPUB follows the OPF spine safely and records deferred remainder at document limits', async () => {
  const temp=await mkdtemp(path.join(os.tmpdir(),'skr-epub-test-'));
  try {
    const input=path.join(temp,'input'),meta=path.join(input,'META-INF'),oebps=path.join(input,'OEBPS');
    await import('node:fs/promises').then(fs=>fs.mkdir(meta,{recursive:true})); await import('node:fs/promises').then(fs=>fs.mkdir(oebps,{recursive:true}));
    await writeFile(path.join(meta,'container.xml'),'<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>');
    await writeFile(path.join(oebps,'book.opf'),'<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>');
    await writeFile(path.join(oebps,'a.xhtml'),'<html><body><h1>First chapter</h1><p>The rabbit enters the garden.</p></body></html>');
    await writeFile(path.join(oebps,'b.xhtml'),'<html><body><p>The fox visits the hill.</p></body></html>');
    execFileSync('zip',['-qr',path.join(temp,'book.epub'),'.'],{cwd:input});
    const bytes=await readFile(path.join(temp,'book.epub'));
    const all=await readSourceContent({content:bytes,name:'book.epub',mimeType:'application/epub+zip'});
    assert.ok(all.regions.some(r=>r.text.includes('rabbit enters'))); assert.ok(all.regions.some(r=>r.text.includes('fox visits')));
    assert.deepEqual(all.regions.map(r=>r.locator.chapter),[1,1,2]);
    const bounded=await readSourceContent({content:bytes,name:'book.epub',mimeType:'application/epub+zip',limits:{maxSpineEntries:1}});
    assert.ok(bounded.coverage.deferred.some(x=>x.locator.chapter===2&&x.state==='deferred'));
  } finally { await rm(temp,{recursive:true,force:true}); }
});
