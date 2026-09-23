import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

const execFile=promisify(execFileCallback),script=new URL('../scripts/build-evaluation-questions.mjs',import.meta.url).pathname;

test('question builder re-reviews repaired quotes and saves original-source offsets',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'skr-question-builder-test-')),output=join(temp,'questions.json'),checkpoints=join(temp,'checkpoints');
  try{
    await execFile(process.execPath,[script,output,'--limit-one',`--checkpoint-dir=${checkpoints}`],{env:{...process.env,SKR_BOOK_QUESTION_MOCK:'1'},maxBuffer:2_000_000});
    const fixture=JSON.parse(await readFile(output,'utf8')),question=fixture.questions.find(q=>q.id==='pg14838-q09');
    assert.equal(fixture.status,'test-only-mock-output');assert.match(fixture.disclaimer,/TEST ONLY/);assert.equal(fixture.questions.length,20);assert.equal(question.question,'What had Peter heard about cats from his cousin?');
    assert.equal(question.expected,'He had heard about cats from his cousin, little Benjamin Bunny.');
    assert.equal(question.evidenceReview.status,'sufficient');assert.equal(question.adjudication.status,'pending-human-review');
    const source=await readFile(new URL('../corpora/books/pg-14838.txt',import.meta.url),'utf8'),span=question.evidence[0];
    assert.equal(source.slice(span.startChar,span.endChar),span.quote);
    const checkpoint=JSON.parse(await readFile(join(checkpoints,'pg14838-2bf0e0429703.json'),'utf8'));
    assert.equal(checkpoint.evidenceReview.status,'sufficient');assert.equal(checkpoint.questions[8].question,question.question);
  }finally{await rm(temp,{recursive:true,force:true});}
});
