import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { generateProcedureCases } from '../src/evaluation/procedures.mjs';
const cases=generateProcedureCases();if(cases.length!==60||new Set(cases.map(c=>c.id)).size!==cases.length)throw new Error('Procedure fixture must contain 60 unique cases');
const fixture={id:'pinned-procedure-contracts-v1',frozen:true,status:'deterministic-contract-fixture',caseCount:cases.length,caseFamilies:Object.fromEntries([...new Set(cases.map(c=>c.family))].map(f=>[f,cases.filter(c=>c.family===f).length])),goldStatus:'automatic-expected-structure-not-expert-judgment',cases};
const text=JSON.stringify(fixture,null,2)+'\n';await writeFile('fixtures/procedures-v1.json',text);process.stdout.write(JSON.stringify({path:'fixtures/procedures-v1.json',caseCount:cases.length,sha256:createHash('sha256').update(text).digest('hex'),families:fixture.caseFamilies},null,2)+'\n');
