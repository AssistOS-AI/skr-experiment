/** Roll up an EVALUATE run from each child baseline's measured current-run stage ledger. */
export function aggregateChildAccounting(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const childStageLedger = safeRows.flatMap(row => row?.result?.cost?.sessions ?? []);
  const rowsWithLedger = new Set(safeRows.filter(row => row?.result?.cost?.sessions?.length));
  const fallbackUsage = safeRows.filter(row => !rowsWithLedger.has(row)).flatMap(row => {
    const cost = row?.result?.cost;
    if (!cost) return [];
    if (cost.usageTotal) {
      const usage = cost.usageTotal;
      return [{
        input_tokens: usage.input_tokens ?? usage.inputTokens ?? 0,
        cached_input_tokens: usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0,
        output_tokens: usage.output_tokens ?? usage.outputTokens ?? 0,
        reasoning_output_tokens: usage.reasoning_output_tokens ?? usage.reasoningOutputTokens ?? 0
      }];
    }
    return [cost.usage, cost.preprocessingUsage, cost.judge?.usage];
  });
  const usage = [...childStageLedger.map(stage => stage.usage), ...fallbackUsage].filter(Boolean).reduce((sum, item) => {
    for (const [key, value] of Object.entries(item)) sum[key] = (Number(sum[key]) || 0) + (Number(value) || 0);
    return sum;
  }, {});
  const sessionIds = [...new Set([
    ...childStageLedger.map(stage => stage.sessionId),
    ...safeRows.map(row => row?.result?.cost?.sessionId)
  ].filter(Boolean))];
  const stageRequests = childStageLedger.reduce((total, stage) => total + (Number(stage.requests) || 0), 0);
  const requests = stageRequests || safeRows.reduce((total, row) => total + (Number(row?.result?.cost?.modelRequests) || 0), 0);
  return { usage, sessionIds, usageLedger: childStageLedger, requests, accounting: childStageLedger.length ? 'current-run-stage-ledger' : 'current-run-cost-fallback' };
}
