import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runProcedureEvaluation } from '../src/evaluation/procedures.mjs';
import { loadFrozenFixture } from '../src/evaluation/frozen-fixture.mjs';
const fixturePath=resolve(process.argv[2]??'fixtures/procedures-v1.json'),outPath=resolve(process.argv[3]??'artifacts/evaluation/procedures-v1-report.json');
const {fixture,lock,sha256}=await loadFrozenFixture(fixturePath);const report=runProcedureEvaluation(fixture.cases);report.fixtureId=fixture.id;report.fixtureCaseCount=fixture.caseCount;report.fixtureSha256=sha256;report.freezeVersion=lock?.freezeVersion??null;
await mkdir(dirname(outPath),{recursive:true});await writeFile(outPath,JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify({status:report.status,cases:report.caseCount,passed:report.passed,failed:report.failed,output:outPath},null,2)+'\n');if(report.status==='failed')process.exitCode=1;
