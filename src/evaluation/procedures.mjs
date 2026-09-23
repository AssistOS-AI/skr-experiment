import { applyProcedure, procedureDefinitions } from '../engine/index.mjs';

const procedures=procedureDefinitions();
const assertion=(id,ske,sourceVersionId,regionId,extra={})=>({id,type:'source-assertion',ske,sourceVersionId,sourceId:sourceVersionId,regionId,quote:ske,lifecycle:'current',supportState:'supported',validation:'source-checked',...extra});
function source(version,records){return {id:version,sourceId:version,sourceVersionId:version,regions:records.map(r=>({id:r.regionId,text:r.quote,locator:{startChar:0,endChar:r.quote.length}}))};}

/** 60 distinct procedure-contract cases: opposition scope, role-sensitive relevance, and anchored complete-work rubric coverage. */
export function generateProcedureCases(){
  const cases=[];
  for(let i=0;i<20;i++){
    const version=`proc_audit_${i}`,timeVariant=i%2===1,attributed=i%4>=2;
    const common={attribution:attributed?'narrator':null,time:'chapter-1',modality:'asserted',world:'story'};
    const left=assertion(`left_${i}`,'(owns alice key)',version,'region-left',{...common,polarity:'positive'});
    const rightScope={...common,polarity:'negative',...(timeVariant?{time:'chapter-2'}:{}),...(attributed?{attribution:'alice'}:{})};
    const right=assertion(`right_${i}`,'(owns alice key)',version,'region-right',rightScope);
    const decoy=assertion(`decoy_${i}`,'(owns bob key)',version,'region-decoy',{...common,polarity:'negative'});
    const records=[left,right,decoy],expectedType=timeVariant||attributed?'scope_difference':'potential_contradiction';
    cases.push({id:`procedure-opposition-${String(i+1).padStart(2,'0')}`,family:'contradiction-audit-scope',procedure:structuredClone(procedures['contradiction-audit']),parameters:structuredClone(procedures['contradiction-audit'].parameters),snapshot:{id:`snapshot_${version}`,sources:[source(version,records)],records,rules:[],procedures:[structuredClone(procedures['contradiction-audit'])]},sourceScope:[version],expected:{findingCount:1,outputTypes:[expectedType],evidenceIdSets:[['left_'+i,'right_'+i]]}});
  }
  for(let i=0;i<20;i++){
    const version=`proc_relevance_${i}`,goal=i%3===0?'(located_in key garden)':i%3===1?'(owns alice key)':'(helps alice rabbit)';
    const args=goal.match(/\((\w+) (.+)\)/),predicate=args[1],terms=args[2].split(' ');
    const matched=assertion(`relevant_${i}`,goal,version,'region-target');
    const reversed=assertion(`reversed_${i}`,`(${predicate} ${terms.slice().reverse().join(' ')})`,version,'region-reversed');
    const lexical=assertion(`lexical_${i}`,'(mentions unrelated key)',version,'region-lexical');
    const records=i%4===0?[reversed,lexical]:[matched,reversed,lexical];
    const resultIds=i%4===0?[]:[`relevant_${i}`];
    cases.push({id:`procedure-relevance-${String(i+1).padStart(2,'0')}`,family:'relevance-exact-role',procedure:structuredClone(procedures['relevance-synthesis']),parameters:{...structuredClone(procedures['relevance-synthesis'].parameters),goal},snapshot:{id:`snapshot_${version}`,sources:[source(version,records)],records,rules:[],procedures:[structuredClone(procedures['relevance-synthesis'])]},sourceScope:[version],expected:{findingCount:resultIds.length,evidenceIds:resultIds,goal}});
  }
  const criteria=procedures['document-literary-rubric'].parameters.criteria;
  for(let i=0;i<20;i++){
    const version=`proc_rubric_${i}`,recordCount=1+(i%5),criterionCount=2+(i%3),selectedCriteria=criteria.slice(0,criterionCount);
    const records=Array.from({length:recordCount},(_,j)=>assertion(`passage_${i}_${j}`,`(passage chapter-${j+1} observation-${i})`,version,`region-${j}`));
    const procedure=structuredClone(procedures['document-literary-rubric']);
    const parameters={criteria:selectedCriteria,confidenceScale:[0,1],requireCounterevidence:true};
    cases.push({id:`procedure-rubric-${String(i+1).padStart(2,'0')}`,family:'complete-work-anchored-rubric',procedure,parameters,snapshot:{id:`snapshot_${version}`,sources:[source(version,records)],records,rules:[],procedures:[procedure]},sourceScope:[version],expected:{findingCount:recordCount*criterionCount,evidenceIdCount:recordCount*criterionCount,criterionIds:selectedCriteria.map(x=>x.id),coverageRecords:recordCount,expertJudgment:false}});
  }
  return cases;
}

export function runProcedureEvaluation(cases=generateProcedureCases()){
  const rows=cases.map(testCase=>{
    const out=applyProcedure({procedure:testCase.procedure,snapshot:testCase.snapshot,parameters:testCase.parameters,sourceScope:testCase.sourceScope});
    const actualEvidence=out.findings.map(f=>f.evidenceIds??[]),actualTypes=out.findings.map(f=>f.outputType),flatEvidence=out.findings.flatMap(f=>f.evidenceIds??[]);
    let passed=false;
    if(testCase.family==='contradiction-audit-scope')passed=out.findings.length===testCase.expected.findingCount&&actualTypes[0]===testCase.expected.outputTypes[0]&&JSON.stringify(actualEvidence[0]?.slice().sort())===JSON.stringify(testCase.expected.evidenceIdSets[0].slice().sort());
    else if(testCase.family==='relevance-exact-role')passed=out.findings.length===testCase.expected.findingCount&&JSON.stringify([...new Set(flatEvidence)].sort())===JSON.stringify(testCase.expected.evidenceIds.slice().sort());
    else passed=out.findings.length===testCase.expected.findingCount&&flatEvidence.length===testCase.expected.evidenceIdCount&&out.coverage.recordsConsidered===testCase.expected.coverageRecords&&out.validation.expertJudgment===false&&out.findings.every(f=>testCase.expected.criterionIds.some(id=>f.text.includes(id)));
    return {id:testCase.id,family:testCase.family,passed,expected:testCase.expected,actual:{findingCount:out.findings.length,outputTypes:actualTypes,evidenceIds:flatEvidence,recordsConsidered:out.coverage.recordsConsidered,validation:out.validation}};
  });
  return {experiment:'pinned-procedure-contract-conformance',caseCount:rows.length,passed:rows.filter(r=>r.passed).length,failed:rows.filter(r=>!r.passed).length,status:rows.every(r=>r.passed)?'passed':'failed',metricsByFamily:Object.fromEntries([...new Set(rows.map(r=>r.family))].map(f=>[f,{cases:rows.filter(r=>r.family===f).length,exactContractAccuracy:rows.filter(r=>r.family===f&&r.passed).length/rows.filter(r=>r.family===f).length}])),rows,interpretation:'Deterministic contract conformance for structural procedure references only. Literary scores and semantic judgments are not produced by this suite; model-produced assessments remain provisional and require expert review.'};
}
