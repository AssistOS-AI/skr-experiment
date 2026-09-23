import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const digest = (s) => createHash('sha256').update(s).digest('hex');
const region = (text, locator, sourceDigest) => ({ id: `region_${digest(`${sourceDigest}\0${JSON.stringify(locator)}`).slice(0, 24)}`, text, locator });

function runProcess(command, args, { timeoutMs = 10_000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', finished = false, timedOut = false, overflow = false;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = result => { if (finished) return; finished = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const push = (target, chunk) => {
      if (Buffer.byteLength(target.value) + chunk.length > maxBytes) { overflow = true; child.kill('SIGKILL'); return target.value; }
      return target.value + chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => { stdout = push({ value: stdout }, chunk); });
    child.stderr.on('data', chunk => { stderr = push({ value: stderr }, chunk); });
    child.on('error', error => finish({ error, status: null, stdout, stderr, timedOut, overflow }));
    child.on('close', status => finish({ error: null, status, stdout, stderr, timedOut, overflow }));
  });
}

function textRegions(text, sourceDigest) {
  const out = [];
  // Locators address the original decoded source string (UTF-16 code units),
  // including CRLF/CR line endings. Do not normalize before measuring offsets.
  let start = 0, lineNumber = 1;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '\n' && text[i] !== '\r') continue;
    const line = text.slice(start, i);
    if (line.trim()) out.push(region(line, { type: 'text-line', line: lineNumber, start, end: i, offsetUnit: 'utf16-code-unit' }, sourceDigest));
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    start = i + 1;
    lineNumber++;
  }
  return out;
}

function markProjectGutenbergWork(text, regions) {
  const start=/\*{3}\s*START OF THE PROJECT GUTENBERG EBOOK\b[^\r\n]*?\*{3}/i.exec(text);
  const end=/\*{3}\s*END OF THE PROJECT GUTENBERG EBOOK\b[^\r\n]*?\*{3}/i.exec(text);
  if(!start||!end||end.index<=start.index) return null;
  const workStart=start.index+start[0].length,workEnd=end.index;
  for(const item of regions){
    const from=item.locator?.start,to=item.locator?.end;
    item.sourceSegment=Number.isInteger(from)&&Number.isInteger(to)
      ?to<=workStart?'front-matter':from>=workEnd?'back-matter':'work'
      :'unclassified';
  }
  return {type:'project-gutenberg-work-v2',offsetUnit:'utf16-code-unit',coordinateBasis:'original-decoded-source',startMarker:start[0],endMarker:end[0],workStartOffset:workStart,workEndOffset:workEnd,workRegionCount:regions.filter(r=>r.sourceSegment==='work').length};
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
    else if (c === '"' && !cell) quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function decodeXml(s) {
  return s.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
function decodeHtml(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function epubTextRegions(html, sourceDigest, chapter, href) {
  const blocks = html.replace(/<(script|style|nav|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|h[1-6]|li|blockquote|tr|section|article)>/gi, '\n')
    .replace(/<br\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return decodeHtml(blocks).split(/\n+/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .map((text, i) => region(text, { type: 'epub-chapter', chapter, href, paragraph: i + 1 }, sourceDigest));
}
async function epubRegions(file, sourceDigest, limits = {}) {
  const names = await runProcess('unzip', ['-Z1', file], { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 });
  if (names.error || names.status !== 0) throw new Error('EPUB central directory could not be read');
  const files = new Set(names.stdout.split(/\r?\n/));
  if (!files.has('META-INF/container.xml')) throw new Error('EPUB container.xml is missing');
  const readEntry = async entry => {
    if (entry.startsWith('/') || entry.split('/').includes('..') || !files.has(entry)) throw new Error(`Unsafe or missing EPUB entry: ${entry}`);
    const out = await runProcess('unzip', ['-p', file, entry], { timeoutMs: 10_000, maxBytes: 12 * 1024 * 1024 });
    if (out.error || out.status !== 0) throw new Error(`Could not read EPUB entry ${entry}`);
    return out.stdout;
  };
  const container = await readEntry('META-INF/container.xml');
  const opfRelative = container.match(/<rootfile\b[^>]*\bfull-path=["']([^"']+)["']/i)?.[1];
  if (!opfRelative || opfRelative.includes('..') || opfRelative.startsWith('/')) throw new Error('EPUB package path is missing or unsafe');
  const opf = await readEntry(opfRelative);
  const base = path.posix.dirname(opfRelative);
  const items = new Map();
  for (const m of opf.matchAll(/<item\b([^>]+)>/gi)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w:-]+)=["']([^"']*)["']/g)].map(x => [x[1], x[2]]));
    if (attrs.id && attrs.href && attrs['media-type'] === 'application/xhtml+xml') items.set(attrs.id, path.posix.normalize(path.posix.join(base, decodeHtml(attrs.href))));
  }
  const spineIds = [...opf.matchAll(/<itemref\b[^>]*\bidref=["']([^"']+)["']/gi)].map(x => x[1]);
  if (!spineIds.length) throw new Error('EPUB spine has no readable XHTML chapters');
  const result = [], deferred = [], started = Date.now(), deadline = started + (limits.maxDocumentMs ?? 90_000);
  const maxSpineEntries=limits.maxSpineEntries??500, maxTotalBytes=limits.maxTotalBytes??50*1024*1024;
  if(spineIds.length>maxSpineEntries) for(let i=maxSpineEntries;i<spineIds.length;i++) deferred.push({locator:{type:'epub-chapter',chapter:i+1,spineId:spineIds[i]},state:'deferred',reason:`EPUB spine entry limit (${maxSpineEntries}) reached.`});
  let totalBytes=0;
  for (const [i, id] of spineIds.slice(0,maxSpineEntries).entries()) {
    const href = items.get(id); if (!href) continue;
    const locator={type:'epub-chapter',chapter:i+1,href};
    if(Date.now()>=deadline||totalBytes>=maxTotalBytes) { deferred.push({locator,state:'deferred',reason:Date.now()>=deadline?'EPUB document-wide extraction deadline reached.':'EPUB aggregate extraction byte limit reached.'}); continue; }
    const html = await readEntry(href);
    totalBytes+=Buffer.byteLength(html);
    if(totalBytes>maxTotalBytes) { deferred.push({locator,state:'deferred',reason:'EPUB aggregate extraction byte limit reached; this chapter was not interpreted.'}); continue; }
    result.push(...epubTextRegions(html, sourceDigest, i + 1, href));
  }
  if (!result.length) throw new Error('EPUB spine contained no XHTML text regions');
  return {regions:result,deferred};
}

/** Read original bytes conservatively into reopenable regions. Unknown formats remain explicit unreadable coverage. */
export async function readSourceContent({ content, name = 'source', mimeType = 'application/octet-stream', limits = {} }) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '');
  const sourceDigest = digest(bytes);
  const ext = name.toLowerCase().split('.').pop();
  const isText = mimeType.startsWith('text/') || ['txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'csv', 'tsv', 'xml', 'html'].includes(ext);
  const result = { digest: sourceDigest, regions: [], coverage: { status: 'readable', regions: 0, deferred: [] }, readerProfile: { id: 'text-structure-v2', format: ext, locatorOffsetUnit: 'utf16-code-unit', locatorCoordinateBasis: 'original-decoded-source' } };
  if (['pdf'].includes(ext) || mimeType === 'application/pdf') {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'skr-pdf-'));
    const started = Date.now(), deadline = started + (limits.maxDocumentMs ?? 90_000), maxPages = limits.maxOcrPages ?? 40, dpi = limits.ocrDpi ?? 130, maxRaster = limits.maxRasterPixels ?? 2500;
    let textResult = { error: new Error('PDF text tool was not run'), status: null, stdout: '', stderr: '' }, pageCount = 0, ocrPages = [];
    try {
      const input = path.join(tempDir, 'source.pdf'); await writeFile(input, bytes, { mode: 0o600 });
      textResult = await runProcess('pdftotext', ['-layout', input, '-'], { timeoutMs: Math.min(15_000, Math.max(1, deadline - Date.now())), maxBytes: 50 * 1024 * 1024 });
      const info = await runProcess('pdfinfo', [input], { timeoutMs: Math.min(5_000, Math.max(1, deadline - Date.now())), maxBytes: 1024 * 1024 });
      pageCount = Number(info.stdout?.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
      const pages = textResult.status === 0 ? textResult.stdout.split('\f') : [];
      while (pages.at(-1)?.trim() === '') pages.pop();
      pageCount ||= pages.length;
      const poppler = await runProcess('pdftotext', ['-v'], { timeoutMs: 3_000, maxBytes: 64 * 1024 });
      const tess = await runProcess('tesseract', ['--version'], { timeoutMs: 3_000, maxBytes: 64 * 1024 });
      result.readerProfile = { id: 'pdf-text-ocr-v1', pageCount, pdfTextTool: (poppler.stderr || poppler.stdout || '').split('\n')[0], ocr: { tool: 'tesseract', version: (tess.stdout || tess.stderr || '').split('\n')[0], language: 'eng', dpi: 130, pageSegmentationMode: 3, maxPages: 40, pageTimeoutMs: 20_000 } };
      result.readerProfile.ocr.dpi = dpi; result.readerProfile.ocr.maxPages = maxPages; result.readerProfile.ocr.maxRasterPixels = maxRaster;
      // OCR empty pages even if pdftotext failed. Raster dimensions are bounded in addition to DPI.
      for (let page = 1; page <= Math.min(pageCount, maxPages); page++) {
        if (pages[page - 1]?.trim()) continue;
        if (Date.now() >= deadline) { ocrPages.push({ page, text: '', error: 'Document-wide OCR time limit reached.' }); continue; }
        const prefix = path.join(tempDir, `page-${page}`), remaining = Math.max(1, deadline - Date.now());
        const raster = await runProcess('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(dpi), '-scale-to', String(maxRaster), '-png', '-singlefile', input, prefix], { timeoutMs: Math.min(12_000, remaining), maxBytes: 2 * 1024 * 1024 });
        const imagePath = `${prefix}.png`;
        if (!raster.error && raster.status === 0) {
          const ocr = await runProcess('tesseract', [imagePath, 'stdout', '--psm', '3', '-l', 'eng'], { timeoutMs: Math.min(12_000, Math.max(1, deadline - Date.now())), maxBytes: 4 * 1024 * 1024 });
          ocrPages.push({ page, text: !ocr.error && ocr.status === 0 ? ocr.stdout.trim() : '', error: ocr.error?.message ?? (ocr.status === 0 ? null : ocr.stderr?.trim() || (ocr.timedOut ? 'tesseract page timeout' : 'tesseract failed')) });
        } else ocrPages.push({ page, text: '', error: raster.error?.message ?? raster.stderr?.trim() ?? (raster.timedOut ? 'pdftoppm page timeout' : 'pdftoppm failed') });
      }
    } catch (error) { textResult = { error, status: null, stdout: textResult.stdout, stderr: error.message }; }
    finally { await rm(tempDir, { recursive: true, force: true }); }
    {
      const pages = textResult.status === 0 ? textResult.stdout.split('\f') : [];
      while (pages.at(-1)?.trim() === '') pages.pop();
      if (pageCount === 0) {
        result.readerDiagnostics = { ocrElapsedMs: Date.now() - started };
        result.coverage = { status: 'unreadable', regions: 0, deferred: [{ locator: { type: 'document' }, state: 'unreadable', reason: `Could not inventory PDF pages: ${textResult.error?.message ?? textResult.stderr ?? 'pdfinfo returned no page count'}` }] };
        return result;
      }
      result.regions = [];
      const deferred = [];
      for (let i = 0; i < Math.max(pages.length, pageCount); i++) {
        const locator = { type: 'pdf-page', page: i + 1 };
        if (pages[i]?.trim()) {
          const pageRegion = region(pages[i].trim(), { ...locator, extraction: 'pdftotext-layout-v1' }, sourceDigest);
          pageRegion.fidelityCaveat = 'PDF text layout extraction; figures, scanned content, and visual structure are not represented.';
          result.regions.push(pageRegion);
          deferred.push({ locator, state: 'readable', reason: 'Page text extracted; figures/layout remain visually uninterpreted.' });
        } else {
          const ocr = ocrPages.find(x => x.page === i + 1);
          if (ocr?.text) {
            const pageRegion = region(ocr.text, { ...locator, extraction: `tesseract-eng-${dpi}dpi-max${maxRaster}px-psm3` }, sourceDigest);
            pageRegion.fidelityCaveat = 'OCR transcription; possible recognition errors. Locator refers to the preserved original PDF page image.';
            result.regions.push(pageRegion);
            deferred.push({ locator: { ...locator, extraction: 'ocr' }, state: 'readable', reason: 'OCR text extracted; recognition may contain errors and original image is preserved.' });
          } else deferred.push({ locator, state: 'unreadable', reason: ocr?.error ? `OCR failed: ${ocr.error}` : 'No extractable text; page may be blank, scanned without OCR text, or beyond the OCR page limit.' });
        }
      }
      result.readerDiagnostics = { ocrElapsedMs: Date.now() - started };
      result.coverage = { status: 'partial', regions: result.regions.length, deferred };
      return result;
    }
  }
  if (ext === 'epub' || mimeType === 'application/epub+zip') {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'skr-epub-'));
    try {
      const file = path.join(tempDir, 'source.epub'); await writeFile(file, bytes, { mode: 0o600 });
      const extracted = await epubRegions(file, sourceDigest, limits);
      result.regions = extracted.regions;
      result.readerProfile = { id: 'epub-spine-xhtml-v1', tool: 'unzip', sourceOrder: 'OPF spine', html: 'structural-text-only' };
      result.coverage = { status: 'partial', regions: result.regions.length, deferred: [...extracted.deferred,{ locator: { type: 'epub-media' }, state: 'deferred', reason: 'Embedded images, audio, scripting, and visual layout are not interpreted.' }] };
    } catch (error) {
      result.coverage = { status: 'unreadable', regions: 0, deferred: [{ locator: { type: 'document' }, state: 'unreadable', reason: `EPUB extraction failed: ${error.message}` }] };
    } finally { await rm(tempDir, { recursive: true, force: true }); }
    return result;
  }
  if (ext === 'docx' || mimeType.includes('wordprocessingml')) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'skr-docx-'));
    let child;
    try {
      const file = path.join(tempDir, 'source.docx'); await writeFile(file, bytes);
      child = await runProcess('unzip', ['-p', file, 'word/document.xml'], { timeoutMs: 20_000, maxBytes: 50 * 1024 * 1024 });
    } finally { await rm(tempDir, { recursive: true, force: true }); }
    if (!child.error && child.status === 0 && child.stdout) {
      const paragraphs = decodeXml(child.stdout).split('\n').filter(x => x.trim());
      result.regions = paragraphs.map((p, i) => region(p, { type: 'docx-paragraph', paragraph: i + 1 }, sourceDigest));
      result.readerProfile = { id: 'docx-main-document-v1', tool: 'unzip', components: ['word/document.xml'] };
      result.coverage = { status: 'partial', regions: result.regions.length, deferred: [{ locator: { type: 'docx-document' }, reason: 'Main document text extracted; tables, headers, footnotes and formatting may be incomplete.' }] };
      return result;
    }
    result.coverage = { status: 'unreadable', regions: 0, deferred: [{ locator: { type: 'document' }, reason: 'DOCX extraction failed; original bytes were preserved.' }] };
    return result;
  }
  if (!isText) {
    result.coverage = { status: 'unreadable', regions: 0, deferred: [{ locator: { type: 'document' }, reason: `Unsupported format (${mimeType}); original bytes were preserved without extraction.` }] };
    return result;
  }
  const text = bytes.toString('utf8');
  if (ext === 'json' || ext === 'jsonl') {
    try {
      if (ext === 'jsonl') {
        result.regions = text.split(/\r?\n/).flatMap((line, i) => line.trim() ? [region(line, { type: 'json-line', line: i + 1 }, sourceDigest)] : []);
      } else {
        JSON.parse(text);
        result.regions = textRegions(text, sourceDigest);
      }
    } catch {
      result.coverage = { status: 'partial', regions: 0, deferred: [{ locator: { type: 'document' }, reason: 'Invalid JSON; no structured regions emitted.' }] };
    }
  } else if (ext === 'csv' || ext === 'tsv') {
    const rows = ext === 'tsv' ? text.split(/\r?\n/).filter(Boolean).map(line => line.split('\t')) : parseCsv(text);
    const headers = rows[0] ?? [];
    result.regions = rows.slice(1).map((cells, i) => {
      const values = headers.map((h, j) => `${h}: ${cells[j] ?? ''}`).join('; ');
      return region(values, { type: 'csv-row', row: i + 2, cells: headers.map((h, j) => ({ column: j + 1, header: h, value: cells[j] ?? '' })) }, sourceDigest);
    });
  } else result.regions = textRegions(text, sourceDigest);
  if (ext==='txt'||ext==='md'||ext==='markdown'||ext==='log') {
    result.workBoundaries=markProjectGutenbergWork(text,result.regions);
    if(result.workBoundaries) result.readerProfile={...result.readerProfile,workBoundaryClassifier:'project-gutenberg-start-end-v1'};
  }
  if (!result.coverage.deferred.length) result.coverage = { status: 'readable', regions: result.regions.length, deferred: [] };
  else result.coverage.regions = result.regions.length;
  return result;
}

/** Group complete source regions into bounded prompt chunks without losing locator boundaries. */
export function chunkSourceRegions(source, { maxChars = 18_000 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new TypeError('maxChars must be a positive integer');
  const chunks = []; let current = [], size = 0;
  for (const region of source.regions ?? []) {
    const textSize = String(region.text ?? '').length;
    if (current.length && size + textSize > maxChars) {
      chunks.push({ id: `chunk_${chunks.length + 1}`, regions: current }); current = []; size = 0;
    }
    // Oversize pages/blocks remain whole so the region locator still reopens the cited text.
    current.push(region); size += textSize;
  }
  if (current.length) chunks.push({ id: `chunk_${chunks.length + 1}`, regions: current });
  return chunks;
}
