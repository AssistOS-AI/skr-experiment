import { writeFile } from 'node:fs/promises';
import { buildMutationFixture } from '../src/evaluation/mutations.mjs';
const count=Number(process.argv.find(x=>x.startsWith('--count='))?.split('=')[1]??60);
const fixture=buildMutationFixture({count});await writeFile('fixtures/mutations-v1.json',JSON.stringify(fixture,null,2)+'\n');console.log(`Wrote ${fixture.cases.length} deterministic mutation cases to fixtures/mutations-v1.json`);
