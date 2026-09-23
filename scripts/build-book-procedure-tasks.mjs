import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { procedureDefinitions } from '../src/engine/index.mjs';

const root=process.cwd(),manifest=JSON.parse(await readFile(join(root,'corpora/books/manifest.json'),'utf8')),defs=procedureDefinitions();
const relevanceProfiles={
  pg14838:['How does Peter Rabbit enter and move through Mr. McGregor’s garden?','What events lead Peter Rabbit from the garden to safety?','How do Peter’s choices affect his encounters in the garden?','Which passages distinguish Peter’s actions from those of his sisters?'],
  pg11757:['How does the toy rabbit’s relationship with the boy change?','What events are presented as signs of becoming real?','How do the nursery toys discuss what it means to be real?','Which events connect the rabbit’s loss to his later transformation?'],
  pg902:['How do the Prince and the Swallow respond to people in need?','What changes in the Swallow’s actions across the tale?','How do the selected tales contrast outward beauty with kindness?','Which events connect sacrifice with the endings of the stories?'],
  pg496:['How does the Little Lame Prince learn about the world beyond the tower?','Which events show changes in the Prince’s independence?','How do the Prince’s journeys affect his relationships with other characters?','Which passages connect hardship with later choices?'],
  pg7256:['How do Della and Jim each respond to the other’s gift?','Which events lead each character to give up a valued possession?','How does the sequence of purchases create the ending’s irony?','Which passages show the difference between monetary value and affection?']
};
const contradictionProfiles=[
  {id:'same-world-time',scopeKeys:['world','time'],instruction:'Check for opposite claims about the same event in the same represented world and time; preserve separate passage citations.'},
  {id:'time-revision',scopeKeys:['time'],instruction:'Distinguish an earlier statement from a later change or correction; do not collapse temporal revision into a same-time contradiction.'},
  {id:'attributed-speech',scopeKeys:['attribution'],instruction:'Keep narrator statements separate from what a character believes, reports, denies, or imagines.'},
  {id:'possibility-vs-observation',scopeKeys:['modality'],instruction:'Do not treat a possibility, plan, wish, fear, or reported belief as an observed event; compare only claims with aligned modality.'}
];
const bodyOf=(book,text)=>{const startToken='*** START OF THE PROJECT GUTENBERG EBOOK',endToken='*** END OF THE PROJECT GUTENBERG EBOOK',a=text.indexOf(startToken),bodyStart=text.indexOf('\n',a)+1,bodyEnd=text.indexOf(endToken,bodyStart);if(a<0||bodyStart<1||bodyEnd<bodyStart)throw new Error(`Complete-work boundary missing: ${book.id}`);return {bodyStart,bodyEnd,body:text.slice(bodyStart,bodyEnd)};};
const windows=(body,bodyStart)=>{const sentences=[...body.matchAll(/[^.!?\n]+[.!?](?:[”’"']?)(?=\s|$)/gu)].map(m=>({start:m.index,end:m.index+m[0].length,quote:m[0].trim()})).filter(x=>x.quote.split(/\s+/u).length>=7);if(sentences.length<4)throw new Error('Not enough complete narrative sentences');return Array.from({length:4},(_,i)=>{const s=sentences[Math.floor((i+0.5)*sentences.length/4)];const leading=s.quote.length-s.quote.trimStart().length;return {...s,startChar:bodyStart+s.start+leading,endChar:bodyStart+s.end,regionId:null};});};
const tasks=[],sourceManifest=[];
for(const book of manifest.books){const bytes=await readFile(join(root,'corpora/books',book.file)),sha=createHash('sha256').update(bytes).digest('hex');if(sha!==book.sha256)throw new Error(`Pinned source digest mismatch: ${book.id}`);const text=bytes.toString('utf8'),{bodyStart,bodyEnd,body}=bodyOf(book,text),anchors=windows(body,bodyStart),sourceVersionId=`${book.id}-${sha.slice(0,16)}`;
  sourceManifest.push({bookId:book.id,title:book.title,author:book.author,sourceVersionId,sourceUrl:book.sourceUrl,digest:sha,path:`corpora/books/${book.file}`,completeWork:{startChar:bodyStart,endChar:bodyEnd,coordinateBasis:'original decoded UTF-8 text string, character offsets'}});
  for(let i=0;i<4;i++){
    const contradiction=defs['contradiction-audit'],relevance=defs['relevance-synthesis'],rubric=defs['document-literary-rubric'];
    const rubricProfiles=[[rubric.parameters.criteria[0],rubric.parameters.criteria[1]],[rubric.parameters.criteria[2],rubric.parameters.criteria[3]],[rubric.parameters.criteria[0],rubric.parameters.criteria[3]],[rubric.parameters.criteria[1],rubric.parameters.criteria[2]]];
    const cases=[
      {procedure:contradiction,procedureId:contradiction.id,procedureVersion:contradiction.version,procedureParameters:{...contradiction.parameters,profile:contradictionProfiles[i]},question:`${contradictionProfiles[i].instruction} Analyze the complete work “${book.title}” and report potential opposition, revision, attributed disagreement, and modality distinctions only with cited passages.`},
      {procedure:relevance,procedureId:relevance.id,procedureVersion:relevance.version,procedureParameters:{question:relevanceProfiles[book.id][i],topic:relevanceProfiles[book.id][i],minimumCoverage:0.8,maximumRedundancy:0.25,redundancyPolicy:'deduplicate-with-citations'},question:relevanceProfiles[book.id][i]},
      {procedure:rubric,procedureId:rubric.id,procedureVersion:rubric.version,procedureParameters:{criteria:rubricProfiles[i],confidenceScale:[0,1],requireCounterevidence:true},question:`Apply the supplied criteria across the complete work “${book.title}”. Separate observable textual evidence from interpretation, retain counterevidence, and mark every judgment provisional pending expert review.`}
    ];
    for(const task of cases){const procedureIndex=task.procedure.id;tasks.push({id:`${book.id}-${procedureIndex}-profile-${i+1}`,family:`full-book-procedure-${procedureIndex}`,sourceId:book.id,sourceVersionId,sourceDigest:sha,sourcePath:`corpora/books/${book.file}`,completeWork:{startChar:bodyStart,endChar:bodyEnd,coordinateBasis:'original decoded UTF-8 text string, character offsets'},anchors:anchors.map(a=>({...a})),procedureId:task.procedureId,procedureVersion:task.procedureVersion,parameters:task.procedureParameters,question:task.question,proposedFinding:{status:'not-generated',records:[]},goldJudgment:{status:'pending-human-review',findings:null,criterionScores:null,reviewer:null,reviewedAt:null},evidenceRequirement:'Every model-proposed finding must cite exact sourceVersionId/regionId passage evidence with reopened quotation and locator. A correct quote alone does not prove interpretation.'});}
  }
}
const output={id:'public-book-procedure-tasks-v1',status:'frozen-task-specifications-pending-execution-and-human-adjudication',frozen:true,bookCount:sourceManifest.length,taskCount:tasks.length,construction:'Five checksum-pinned complete public-domain books × three canonical pinned procedures × four distinct parameter profiles. Source anchors are exact original-text locations; no semantic result or expert score is fabricated.',books:sourceManifest,procedures:Object.values(defs),cases:tasks};
if(tasks.length!==60)throw new Error(`Expected exactly 60 tasks, found ${tasks.length}`);
const serialized=JSON.stringify(output,null,2)+'\n';await writeFile(join(root,'fixtures/book-procedure-tasks-v1.json'),serialized);console.log(JSON.stringify({path:'fixtures/book-procedure-tasks-v1.json',taskCount:tasks.length,sha256:createHash('sha256').update(serialized).digest('hex')},null,2));
