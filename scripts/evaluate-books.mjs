import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runBookOfflineEvaluation, BASELINE_IDS } from '../src/evaluation/index.mjs';
const args=process.argv.slice(2),fixturePath=args.find(x=>x.startsWith('--fixture='))?.slice('--fixture='.length)??args.find(x=>!x.startsWith('--'))??'fixtures/book-questions-v1.json';
const get=prefix=>args.find(x=>x.startsWith(prefix))?.slice(prefix.length);
const baselines=get('--baselines=')?.split(',').filter(Boolean)??BASELINE_IDS,mode=get('--mode=')??'equal-budget',output=get('--out=')??'artifacts/book-offline-evaluation.json';
const report=await runBookOfflineEvaluation({fixturePath,baselines,mode});const manifest=JSON.parse(await readFile('corpora/books/manifest.json','utf8'));await mkdir('artifacts',{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({status:'completed',fixturePath,caseCount:report.caseCount,bookCount:manifest.books?.length??null,baselines,mode,adjudicationStatus:'pending-human-review',reportPath:output,interpretation:report.interpretation},null,2));
