import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, basename } from 'node:path';

const positional=process.argv.slice(2).filter(x=>!x.startsWith('--'));
const fixturePath=resolve(positional[0]??'fixtures/controlled-v2.json');
const lockPath=resolve(positional[1]??`${fixturePath}.lock.json`);
const refresh=process.argv.includes('--refresh'),freezeProposed=process.argv.includes('--freeze-proposed');
const bytes=await readFile(fixturePath),fixture=JSON.parse(bytes.toString('utf8'));
const entries=fixture.cases??fixture.questions;
if(fixture.frozen!==true&&!freezeProposed)throw new Error('Fixture is not marked frozen; use --freeze-proposed only for a reviewed structure whose automatic gold remains disclosed.');
if(!Array.isArray(entries)||entries.length<1)throw new Error('Fixture contains no cases/questions');
const ids=new Set();for(const c of entries){if(!c.id||ids.has(c.id))throw new Error(`Fixture case IDs must be unique: ${c.id}`);ids.add(c.id);}
const sha256=createHash('sha256').update(bytes).digest('hex');
let previous=null;try{previous=JSON.parse(await readFile(lockPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(previous&&previous.sha256!==sha256&&!refresh)throw new Error(`Frozen fixture changed (${previous.sha256} -> ${sha256}); pass --refresh to create a new explicit version`);
const lock={fixture:basename(fixturePath),fixtureId:fixture.id,sha256,caseCount:entries.length,entryType:fixture.cases?'cases':'questions',goldStatus:fixture.goldStatus??fixture.status??'not-specified',frozenAt:new Date().toISOString(),previousSha256:previous?.sha256??null,freezeVersion:(previous?.freezeVersion??0)+1,warning:'A frozen fixture hash establishes byte identity only; it does not establish expert-verified gold.'};
await mkdir(dirname(lockPath),{recursive:true});await writeFile(lockPath,JSON.stringify(lock,null,2)+'\n');process.stdout.write(JSON.stringify({path:fixturePath,lockPath,...lock},null,2)+'\n');
