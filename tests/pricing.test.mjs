import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPriceSchedule, priceUsage } from '../src/evaluation/pricing.mjs';

test('optional dated prices separate cached input from uncached input without double counting',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'skr-price-'));
  try{const path=join(dir,'prices.json'),schedule={model:'gpt-6-luna',currency:'USD',effectiveDate:'2026-09-23',inputPerMillion:2,cachedInputPerMillion:0.2,outputPerMillion:8};await writeFile(path,JSON.stringify(schedule));const loaded=await loadPriceSchedule(path,{model:'gpt-6-luna',asOf:'2026-09-23'});const cost=priceUsage({input_tokens:1000000,cached_input_tokens:400000,output_tokens:100000},loaded);assert.equal(cost.inputCost,1.2);assert.equal(cost.cachedInputCost,0.08);assert.equal(cost.outputCost,0.8);assert.equal(cost.total,2.08);assert.equal(await loadPriceSchedule(null),null);assert.equal(priceUsage({input_tokens:10},null),null);assert.throws(()=>priceUsage({input_tokens:5,cached_input_tokens:6},loaded),/cannot exceed/);}finally{await rm(dir,{recursive:true,force:true});}
});
