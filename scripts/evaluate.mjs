import { runEvaluation } from '../src/evaluation/index.mjs';
const args=process.argv.slice(2),fixturePath=args.find(x=>!x.startsWith('--'))??'fixtures/controlled-v2.json';
const baselinesArg=args.find(x=>x.startsWith('--baselines='));
const baselines=baselinesArg?baselinesArg.slice('--baselines='.length).split(',').filter(Boolean):['skr-direct','skr-full'];
const report=await runEvaluation({fixturePath,baselines});
console.log(JSON.stringify(report,null,2));
if(report.status==='failed') process.exitCode=1;
