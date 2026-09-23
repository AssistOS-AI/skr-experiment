import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateChildAccounting } from '../src/runtime/run-accounting.mjs';

test('EVALUATE run totals include every current-run child session stage once',()=>{
 const rows=[{baseline:'graphrag',result:{cost:{sessionId:'answer',modelRequests:2,usageTotal:{inputTokens:30},sessions:[{stage:'answer-and-query-planning',sessionId:'answer',requests:2,usage:{input_tokens:20,cached_input_tokens:5,output_tokens:3}},{stage:'graph-preprocessing',sessionId:'graph',requests:1,usage:{input_tokens:10,cached_input_tokens:2,output_tokens:4}},{stage:'independent-judge',sessionId:'judge',requests:1,usage:{input_tokens:7,cached_input_tokens:1,output_tokens:2}}]}}}];
 const result=aggregateChildAccounting(rows);assert.deepEqual(result.sessionIds,['answer','graph','judge']);assert.deepEqual(result.usage,{input_tokens:37,cached_input_tokens:8,output_tokens:9});assert.equal(result.requests,4);assert.equal(result.usageLedger.length,3);assert.equal(result.accounting,'current-run-stage-ledger');
});

test('EVALUATE totals preserve legacy current-run costs when no stage ledger exists',()=>{
 const result=aggregateChildAccounting([{result:{cost:{sessionId:'legacy',modelRequests:2,usage:{input_tokens:12,output_tokens:5},preprocessingUsage:{input_tokens:4},judge:{usage:{output_tokens:2}}}}}]);assert.deepEqual(result.sessionIds,['legacy']);assert.deepEqual(result.usage,{input_tokens:16,output_tokens:7});assert.equal(result.requests,2);assert.equal(result.accounting,'current-run-cost-fallback');
});
