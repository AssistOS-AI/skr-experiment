import { parseSKE, printSKE } from '../engine/index.mjs';

function replaceEntity(ast, fromId, toId) {
  if (ast?.type === 'call') return { ...ast, args: ast.args.map(arg => replaceEntity(arg, fromId, toId)) };
  if (ast?.type === 'and') return { ...ast, terms: ast.terms.map(term => replaceEntity(term, fromId, toId)) };
  if (ast?.type === 'atom' && ast.value === fromId) return { ...ast, value: toId };
  return structuredClone(ast);
}

/** Create an explicit reversible alias reconciliation proposal over a selected record set. */
export function reconcileEntityAliases({ records, fromEntityId, toEntityId, operationId, reviewedBy } = {}) {
  if (!Array.isArray(records) || !fromEntityId || !toEntityId || fromEntityId === toEntityId) throw new TypeError('records and distinct entity IDs are required');
  const changed = [], inverse = [];
  for (const input of records) {
    let next = structuredClone(input), touched = false;
    if (typeof next.ske === 'string') {
      const ast = parseSKE(next.ske), rewritten = replaceEntity(ast, fromEntityId, toEntityId), printed = printSKE(rewritten);
      if (printed !== next.ske) { next.ske = printed; touched = true; }
    }
    if (Array.isArray(next.entityMentions)) {
      for (const mention of next.entityMentions) if (mention.entityId === fromEntityId) {
        mention.reconciledFrom = fromEntityId; mention.entityId = toEntityId; mention.decision = 'same-as'; mention.reversible = true; touched = true;
      }
    }
    if (touched) {
      next.validation = 'entity-reconciled'; next.origin = 'entity-reconciliation';
      next.entityReconciliation = { operationId: operationId ?? null, fromEntityId, toEntityId, reviewedBy: reviewedBy ?? null };
      changed.push(next); inverse.push(structuredClone(input));
    }
  }
  return {
    fromEntityId, toEntityId,
    changeSet: { records: changed },
    undo: { operation: 'restore-records', records: inverse },
    changedRecordIds: changed.map(record => record.id)
  };
}

/** Restore the exact prior records returned in a reconciliation undo token. */
export function undoEntityReconciliation(undo) {
  if (undo?.operation !== 'restore-records' || !Array.isArray(undo.records)) throw new TypeError('A reconciliation undo token is required');
  return { records: structuredClone(undo.records) };
}
