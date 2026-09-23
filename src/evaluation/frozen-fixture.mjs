import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Load a frozen on-disk fixture and verify its sibling digest before evaluation. */
export async function loadFrozenFixture(path,{entries=['cases','questions'],allowUnfrozen=false}={}) {
  const bytes=await readFile(path),fixture=JSON.parse(bytes.toString('utf8'));
  const list=entries.map(key=>fixture[key]).find(Array.isArray);
  if(!Array.isArray(list)||!list.length)throw new Error(`Fixture ${path} has no nonempty ${entries.join('/')} collection`);
  const lockPath=`${path}.lock.json`;
  let lock=null;try{lock=JSON.parse(await readFile(lockPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!lock){if(!allowUnfrozen)throw new Error(`Frozen fixture allow-list required for ${path}`);return {fixture,lock:null,sha256:createHash('sha256').update(bytes).digest('hex')};}
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if(lock.sha256!==sha256)throw new Error(`Frozen fixture hash mismatch for ${path}: expected ${lock.sha256}, got ${sha256}`);
  if(lock.fixtureId&&fixture.id&&lock.fixtureId!==fixture.id)throw new Error(`Frozen fixture identity mismatch for ${path}`);
  if(lock.caseCount!==undefined&&lock.caseCount!==list.length)throw new Error(`Frozen fixture count mismatch for ${path}`);
  return {fixture,lock,sha256};
}
