const safe = value => String(value).replace(/[^A-Za-z0-9_-]/g,'_');
function assertion(id,ske,fields={}) { return {id,ske,sourceVersionId:'src_controlled',regionId:`region_${safe(id)}`,quote:`Controlled assertion ${id}: ${ske}.`,lifecycle:'current',supportState:'supported',...fields}; }
function testCase(id,family,goal,records,{expected='supported',scopeQuery=null,rules=[],gold={}}={}) { return {id,family,question:`Resolve the structured query ${goal}.`,goal,records,scope:['src_controlled'],scopeQuery,expected,rules,gold}; }

export function generateControlledCases() {
  const cases=[];
  const predicates=['owns','located_in','reports_to','contains','founded_by','authored','connects','depends_on','visited','approved'];

  // Exact ground claims vary predicate, arity, literals, polarity, modality and time.
  for(let i=0;i<30;i++) {
    const p=predicates[i%predicates.length],subject=`entity_${i}`,object=i%6===0?`"record ${i}"`:`value_${(i*7)%41}`;
    const scope={time:i%4===0?`year_${1980+i%40}`:null,modality:i%5===0?'possible':i%5===1?'reported':'asserted',attribution:i%7===0?`speaker_${i%5}`:null,polarity:i%8===0?'negative':'positive',world:i%9===0?`world_${i%3}`:null};
    const row=assertion(`direct_${i}`,`(${p} ${subject} ${object})`,scope);
    cases.push(testCase(`direct-${String(i+1).padStart(3,'0')}`,'exact-qualified-assertions',row.ske,[row],{scopeQuery:{...scope,world:scope.world??null},gold:{recordIds:[row.id]}}));
  }

  // Multi-premise conjunctions include partial decoys and deliberately shuffled source order.
  for(let i=0;i<64;i++) {
    const n=2+i%4,person=`person_${i}`,records=[],parts=[],ids=[];
    for(let j=0;j<n;j++){const p=['member_of','works_at','lives_in','speaks','belongs_to'][j],v=`value_${i}_${j}`,row=assertion(`join_${i}_${j}`,`(${p} ${person} ${v})`);records.push(row);parts.push(`(${p} ?who ${v})`);ids.push(row.id);}
    const fake=`person_decoy_${i}`;for(let j=0;j<Math.min(i%3,n-1);j++){const p=['member_of','works_at','lives_in','speaks','belongs_to'][j];records.splice((i+j)%(records.length+1),0,assertion(`decoy_${i}_${j}`,`(${p} ${fake} value_${i}_${j})`));}
    if(i%2)records.reverse();
    cases.push(testCase(`join-${String(i+1).padStart(3,'0')}`,'multi-premise-joins',`(find (?who) (and ${parts.join(' ')}))`,records,{gold:{recordIds:ids,bindings:[{who:{type:'atom',value:person}}]}}));
  }

  // Tuple-set tests catch marginal-binding scoring: the correct answer is two paired rows,
  // while crossed person/city combinations share all individual values but are false.
  for(let i=0;i<24;i++) {
    const p=`people_${i}`,org=`org_${i}`,a=`a_${i}`,b=`b_${i}`,records=[];
    for(const [person,unit,city,k] of [[`${p}_one`,`${org}_one`,a,'one'],[`${p}_two`,`${org}_two`,b,'two']]) {
      records.push(assertion(`assigned_${i}_${k}`,`(assigned_to ${person} ${unit})`));
      records.push(assertion(`city_${i}_${k}`,`(located_in ${unit} ${city})`));
    }
    records.push(assertion(`marginal_decoy_${i}`,`(not_a_join ${p} ${a})`));
    const goal=`(find (?person ?city) (and (assigned_to ?person ?unit) (located_in ?unit ?city)))`;
    cases.push(testCase(`tuple-set-${String(i+1).padStart(3,'0')}`,'complete-multi-tuple-enumeration',goal,records,{gold:{recordIds:[`assigned_${i}_one`,`city_${i}_one`,`assigned_${i}_two`,`city_${i}_two`],bindings:[{person:{type:'atom',value:`${p}_one`},city:{type:'atom',value:a}},{person:{type:'atom',value:`${p}_two`},city:{type:'atom',value:b}}]}}));
  }

  // Rule paths vary between 2 and 8 edges, premise order, branch traps and shortcuts.
  for(let i=0;i<60;i++) {
    const hops=2+i%7,nodes=Array.from({length:hops+1},(_,j)=>`node_${i}_${j}`),records=[];
    const edges=Array.from({length:hops},(_,j)=>assertion(`path_${i}_${j}`,`(edge ${nodes[j]} ${nodes[j+1]})`));if(i%2)edges.reverse();records.push(...edges);
    if(i%3===0)records.push(assertion(`branch_${i}`,`(edge ${nodes[1]} decoy_${i})`));
    if(i%5===0)records.push(assertion(`shortcut_${i}`,`(edge ${nodes[0]} shortcut_${i})`));
    const rules=[{id:`reach_base_${i}`,version:'1',premises:['(edge ?x ?y)'],conclusion:'(reachable ?x ?y)'},{id:`reach_recursive_${i}`,version:'1',premises:['(edge ?x ?y)','(reachable ?y ?z)'],conclusion:'(reachable ?x ?z)'}];
    cases.push(testCase(`multihop-${String(i+1).padStart(3,'0')}`,'bounded-multihop-graphs',`(reachable ${nodes[0]} ${nodes.at(-1)})`,records,{rules,gold:{recordIds:edges.map(e=>e.id)}}));
  }

  // Only half of these are aligned; the other half explicitly test wrong-time/modality/speaker/world.
  const dimensions=['time','modality','attribution','world'];
  for(let i=0;i<48;i++) {
    const p=`event_${i}`,who=`subject_${i}`,dim=dimensions[i%4],scope={time:null,modality:'asserted',attribution:null,world:null,polarity:'positive'};
    scope[dim]=dim==='time'?`period_${i%7}`:dim==='modality'?'possible':dim==='attribution'?`narrator_${i%6}`:`world_${i%5}`;
    const row=assertion(`scope_${i}`,`(${p} ${who})`,scope),queryScope={...scope};let expected='supported';
    if(i>=24){queryScope[dim]=dim==='time'?`different_${i}`:dim==='modality'?'asserted':dim==='attribution'?`other_${i}`:`other_world_${i}`;expected='unresolved';}
    cases.push(testCase(`scope-${String(i+1).padStart(3,'0')}`,'aligned-and-misaligned-qualifiers',row.ske,[row],{expected,scopeQuery:queryScope,gold:{recordIds:expected==='supported'?[row.id]:[]}}));
  }

  // Same-scope polarity opposition is contested; differing-time history is a supported selected revision.
  for(let i=0;i<20;i++) {
    const p=`claim_${i}`,x=`subject_${i}`,base=`(${p} ${x})`,time=`year_${2000+i}`;
    if(i<10){const q={time,modality:'asserted',attribution:null,world:null,polarity:'positive'},positive=assertion(`op_positive_${i}`,base,q),negative=assertion(`op_negative_${i}`,base,{...q,polarity:'negative'});cases.push(testCase(`opposition-${String(i+1).padStart(3,'0')}`,'same-scope-opposition',base,[positive,negative],{expected:'contested',scopeQuery:q,gold:{recordIds:[positive.id,negative.id]}}));}
    else{const old=assertion(`revision_old_${i}`,base,{time:`year_${1990+i}`,modality:'asserted'}),current=assertion(`revision_current_${i}`,base,{time,modality:'asserted'});cases.push(testCase(`revision-${String(i-9).padStart(3,'0')}`,'temporal-revision-not-contradiction',base,[old,current],{scopeQuery:{time,modality:'asserted',attribution:null,world:null,polarity:'positive'},gold:{recordIds:[current.id]}}));}
  }

  // Genuine incomplete joins: all but one premise are present and the output must keep a residual.
  for(let i=0;i<36;i++) {
    const n=3+i%4,x=`candidate_${i}`,parts=[],records=[],ids=[];const missing=(i*3)%n;
    for(let j=0;j<n;j++){const p=`requirement_${i}_${j}`,value=`v_${i}_${j}`;parts.push(`(${p} ?x ${value})`);if(j!==missing){const row=assertion(`premise_${i}_${j}`,`(${p} ${x} ${value})`);records.push(row);ids.push(row.id);}}
    cases.push(testCase(`missing-${String(i+1).padStart(3,'0')}`,'incomplete-join-evidence',`(find (?x) (and ${parts.join(' ')}))`,records,{expected:'unresolved',gold:{recordIds:ids,residualPredicates:[`requirement_${i}_${missing}`]}}));
  }

  // An exception follows a multi-premise rule path and collides with an explicit scoped negative.
  for(let i=0;i<32;i++) {
    const x=`eligible_${i}`,scope={time:i%4===0?`t${i%6}`:null,modality:i%3===0?'reported':'asserted',attribution:i%5===0?`speaker_${i%4}`:null,world:null,polarity:'positive'};
    const a=assertion(`rule_basis_a_${i}`,`(trained ${x})`,scope),b=assertion(`rule_basis_b_${i}`,`(active ${x})`,scope),negative=assertion(`exception_${i}`,`(can_access ${x})`,{...scope,polarity:'negative'});
    const rules=[{id:`access_${i}`,version:'1',premises:['(trained ?x)','(active ?x)'],conclusion:'(can_access ?x)'}];
    cases.push(testCase(`exception-${String(i+1).padStart(3,'0')}`,'rule-exception-counterevidence',`(can_access ${x})`,[a,b,negative],{expected:'contested',scopeQuery:scope,rules,gold:{recordIds:[a.id,b.id,negative.id]}}));
  }

  // Authorization and lifecycle traps include staged/unresolved rows, foreign sources and role reversals.
  for(let i=0;i<32;i++) {
    const predicate=`owns_${i}`,left=`person_${i}`,right=`object_${i}`;let row,goal,sourceScope=['src_controlled'];
    if(i%4===0){row=assertion(`stale_${i}`,`(${predicate} ${left} ${right})`,{lifecycle:'stale'});goal=row.ske;}
    else if(i%4===1){row=assertion(`staged_${i}`,`(${predicate} ${left} ${right})`,{lifecycle:'staged',supportState:'unresolved'});goal=row.ske;}
    else if(i%4===2){row=assertion(`foreign_${i}`,`(${predicate} ${left} ${right})`,{sourceVersionId:`src_foreign_${i}`});goal=row.ske;}
    else{row=assertion(`role_${i}`,`(${predicate} ${left} ${right})`);goal=`(${predicate} ${right} ${left})`;}
    cases.push(testCase(`robust-${String(i+1).padStart(3,'0')}`,'lifecycle-scope-and-role-robustness',goal,[row],{expected:'unresolved',gold:{recordIds:[]}}));
  }

  const total=30+64+24+60+48+20+36+32+32;
  if(cases.length!==total||new Set(cases.map(c=>c.id)).size!==total)throw new Error(`Controlled generator invariant failed: ${cases.length}/${total}`);
  return cases;
}
