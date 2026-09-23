import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
const execFile=promisify(execFileCallback),script=new URL('../scripts/adjudicate-book-questions.mjs',import.meta.url).pathname;
const csvCell=x=>'"'+String(x??'').replaceAll('"','""')+'"';
async function prepare(){const dir=await mkdtemp(join(tmpdir(),'skr-adjudication-')),input=join(dir,'fixture.json'),csv=join(dir,'review.csv');const fixture={id:'unit',status:'pending',questions:[{id:'q1',expected:'proposal 1',evidence:[{quote:'quote, with comma'}]},{id:'q2',expected:'proposal 2',evidence:[{quote:'line one\nline two'}]},{id:'q3',expected:'proposal 3',evidence:[{quote:'quote 3'}]}]};await writeFile(input,JSON.stringify(fixture));await execFile(process.execPath,[script,'export',input,csv]);return {dir,input,csv,fixture};}

test('human review CSV round trips decisions and preserves proposed answers',async()=>{
  const x=await prepare();try{const csv=await readFile(x.csv,'utf8');assert.match(csv,/"decision"/);assert.match(csv,/line one\nline two/);const header=['id','sourceId','category','question','proposedAnswer','evidenceQuotes','decision','correctedAnswer','reviewer','notes'];const decisions=[['q1','','','','','','accept','','','checked'],['q2','','','','','','revise','Corrected answer','','quote verified'],['q3','','','','','','reject','','','unsupported']];await writeFile(x.csv,[header,...decisions].map(r=>r.map(csvCell).join(',')).join('\n')+'\n');await execFile(process.execPath,[script,'import',x.input,x.csv],{env:{...process.env,SKR_ADJUDICATOR:'Reviewer A'}});const out=JSON.parse(await readFile(x.input,'utf8'));assert.equal(out.status,'human-adjudicated');assert.equal(out.questions[0].expected,'proposal 1');assert.equal(out.questions[0].adjudicatedAnswer,'proposal 1');assert.equal(out.questions[1].expected,'proposal 2');assert.equal(out.questions[1].adjudicatedAnswer,'Corrected answer');assert.equal(out.questions[2].adjudication.status,'rejected');assert.equal(out.questions[2].adjudicatedAnswer,null);assert.equal(out.questions[0].adjudication.reviewer,'Reviewer A');}finally{await rm(x.dir,{recursive:true,force:true});}
});

test('human review import rejects duplicate and unknown IDs',async()=>{
  const x=await prepare();try{const header=['id','sourceId','category','question','proposedAnswer','evidenceQuotes','decision','correctedAnswer','reviewer','notes'];await writeFile(x.csv,[header,['q1','','','','','','accept','','',''],['q1','','','','','','accept','','',''],['unknown','','','','','','accept','','','']].map(r=>r.map(csvCell).join(',')).join('\n')+'\n');await assert.rejects(execFile(process.execPath,[script,'import',x.input,x.csv],{env:{...process.env,SKR_ADJUDICATOR:'Reviewer A'}}),/Missing or duplicate review ID/);}finally{await rm(x.dir,{recursive:true,force:true});}
});
