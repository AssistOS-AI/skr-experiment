import { readFile, writeFile } from 'node:fs/promises';

const [mode,input='fixtures/book-questions-v1.json',output='fixtures/book-questions-review.csv']=process.argv.slice(2);
const data=JSON.parse(await readFile(input,'utf8'));
const csvCell=x=>'"'+String(x??'').replaceAll('"','""')+'"';
function parseCsv(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(quoted){if(ch==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(ch==='"')quoted=false;else cell+=ch;}else if(ch==='"')quoted=true;else if(ch===','){row.push(cell);cell='';}else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=ch;}if(cell||row.length){row.push(cell);rows.push(row);}const [header,...body]=rows;return body.filter(r=>r.length).map(r=>Object.fromEntries(header.map((k,i)=>[k,r[i]??''])));}
if(mode==='export'){
  const header=['id','sourceId','category','question','proposedAnswer','evidenceQuotes','decision','correctedAnswer','reviewer','notes'];
  const rows=data.questions.map(q=>[q.id,q.sourceId,q.category,q.question,q.expected,q.evidence.map(x=>x.quote).join('\n---\n'),'','','','']);
  await writeFile(output,[header,...rows].map(row=>row.map(csvCell).join(',')).join('\n')+'\n');
  process.stdout.write(`Exported ${rows.length} questions for independent human review: ${output}\n`);
}else if(mode==='import'){
  const reviewer=process.env.SKR_ADJUDICATOR?.trim();if(!reviewer)throw new Error('Set SKR_ADJUDICATOR to the human reviewer identity before importing decisions.');
  const decisions=parseCsv(await readFile(output,'utf8'));
  const byId=new Map();for(const d of decisions){if(!d.id||byId.has(d.id))throw new Error(`Missing or duplicate review ID: ${d.id}`);byId.set(d.id,d);}const expectedIds=new Set(data.questions.map(q=>q.id));for(const id of byId.keys())if(!expectedIds.has(id))throw new Error(`Unknown review ID ${id}`);if(byId.size!==expectedIds.size)throw new Error('Review CSV must contain exactly one decision for every question');const now=new Date().toISOString();
  for(const q of data.questions){const d=byId.get(q.id);if(!d)throw new Error(`Missing reviewer decision for ${q.id}`);if(!['accept','revise','reject'].includes(d.decision))throw new Error(`Invalid decision for ${q.id}`);if(d.decision==='revise'&&!String(d.correctedAnswer??'').trim())throw new Error(`Revised answer required for ${q.id}`);q.adjudicatedAnswer=d.decision==='accept'?q.expected:d.decision==='revise'?String(d.correctedAnswer).trim():null;q.adjudication={status:d.decision==='reject'?'rejected':'human-adjudicated',reviewer,reviewedAt:now,decision:d.decision,notes:String(d.notes??''),correctedAnswer:d.decision==='revise'?String(d.correctedAnswer).trim():null};}
  data.status='human-adjudicated';data.proposalAnswersPreserved=true;await writeFile(input,JSON.stringify(data,null,2)+'\n');process.stdout.write(`Imported human decisions for ${data.questions.length} questions from ${reviewer}.\n`);
}else throw new Error('Usage: node scripts/adjudicate-book-questions.mjs export [fixture.json] [review.csv] | import [fixture.json] completed-review.csv; set SKR_ADJUDICATOR for import');
