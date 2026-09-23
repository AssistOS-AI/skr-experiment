import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(join(root,'corpora/books/manifest.json'),'utf8'));
const cleanSentences=[];
for (const book of manifest.books) {
  const bytes=await readFile(join(root,'corpora/books',book.file));
  const text=bytes.toString('utf8');
  if (createHash('sha256').update(bytes).digest('hex')!==book.sha256) throw new Error(`Checksum mismatch for ${book.id}`);
  const start=text.indexOf('*** START OF THE PROJECT GUTENBERG EBOOK');
  const bodyStart=text.indexOf('\n',start)+1;
  const end=text.indexOf('*** END OF THE PROJECT GUTENBERG EBOOK',bodyStart);
  if (start<0||bodyStart<0||end<0) throw new Error(`Missing full-work markers for ${book.id}`);
  const body=text.slice(bodyStart,end);
  const sentences=[];
  for (const match of body.matchAll(/[^\n.!?]{40,240}[.!?](?:[”’"']?)(?=\s|$)/g)) {
    const sentence=match[0].replace(/\s+/g,' ').trim();
    if (sentence.split(/\s+/).length<7) continue;
    const absolute=bodyStart+match.index;
    const line=text.slice(0,absolute).split('\n').length;
    if (/^[A-Z][a-z]+:/.test(sentence) || sentence.startsWith('***')) continue;
    sentences.push({sentence,line});
  }
  if (sentences.length<20) throw new Error(`${book.id} yielded only ${sentences.length} sentence candidates`);
  // Spread selections across the entire complete work, keeping each question independently located.
  const selected=Array.from({length:20},(_,i)=>sentences[Math.floor((i+0.5)*sentences.length/20)]);
  cleanSentences.push({book,selected});
}
const cases=[];
for (const {book,selected} of cleanSentences) for (let i=0;i<selected.length;i++) {
  const {sentence,line}=selected[i];
  const words=sentence.split(/\s+/);
  const anchor=words.slice(0,Math.min(7,words.length-2)).join(' ');
  cases.push({
    id:`${book.id}-q${String(i+1).padStart(2,'0')}`,
    family:'public-book-located-quotation',
    source:{bookId:book.id,sourceUrl:book.sourceUrl,sha256:book.sha256,locator:{line},regionId:`line-${line}`},
    question:`In ${book.title}, find the complete sentence at the passage beginning “${anchor}”.`,
    gold:{answer:sentence,evidence:{regionId:`line-${line}`,line,quote:sentence},provenance:'automatic exact-sentence extraction from checksum-pinned complete source',adjudication:{status:'pending-human-review',reviewer:null,reviewedAt:null,notes:null}},
    reviewStatus:'automatic-proposal-only'
  });
}
const output={id:'skr-public-books-qa-v1',frozen:false,construction:'Deterministic, spread-across-complete-source exact-locator questions. Gold is verbatim source text and is not expert-adjudicated; every case requires review before research reporting.',bookCount:manifest.books.length,questionCount:cases.length,books:manifest.books.map(({id,title,author,sourceUrl,sha256})=>({id,title,author,sourceUrl,sha256})),cases};
await writeFile(join(root,'fixtures/public-books-v1.json'),JSON.stringify(output,null,2)+'\n');
console.log(`Wrote ${cases.length} auto-proposed questions across ${manifest.books.length} complete books; human adjudication remains pending.`);
