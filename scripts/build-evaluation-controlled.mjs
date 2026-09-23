import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { generateControlledCases } from '../src/evaluation/controlled-generator.mjs';

const destination=resolve(process.argv[2]??'fixtures/controlled-v2.json');
const cases=generateControlledCases();
const expected=346;
if(cases.length!==expected||new Set(cases.map(c=>c.id)).size!==cases.length)throw new Error(`Controlled case count/id invariant failed: ${cases.length}/${expected}`);
const fixture={id:'controlled-acceptance-v2',status:'frozen-generated-cases',frozen:true,generator:'controlled-generator-v1',createdAt:'2026-09-23',caseCount:cases.length,families:Object.fromEntries([...new Set(cases.map(c=>c.family))].map(f=>[f,cases.filter(c=>c.family===f).length])),cases};
const serialized=JSON.stringify(fixture,null,2)+'\n';await mkdir(dirname(destination),{recursive:true});await writeFile(destination,serialized);process.stdout.write(JSON.stringify({path:destination,cases:cases.length,families:fixture.families,sha256:createHash('sha256').update(serialized).digest('hex')},null,2)+'\n');
