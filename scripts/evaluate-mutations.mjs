import { writeFile, mkdir } from 'node:fs/promises';
import { runMutationEvaluation } from '../src/evaluation/mutations.mjs';
const fixturePath=process.argv.slice(2).find(x=>!x.startsWith('--'))??'fixtures/mutations-v1.json';
const report=await runMutationEvaluation({fixturePath});const output=process.env.SKR_MUTATION_REPORT??'artifacts/mutation-evaluation-report.json';await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({status:report.status,caseCount:report.caseCount,passed:report.passed,failed:report.failed,families:report.families,reportPath:output},null,2));if(report.status!=='passed')process.exitCode=1;
