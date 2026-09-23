# SKR Reason v1.0

## Inputs
Use named premises, optional goal, explicit pinned rules/procedures, project policy and the bounded reasoning settings in the snapshot. No implicit world knowledge may be added as a premise.

## Derivation
Apply only range-restricted rules whose variables are grounded by premises. Preserve joins, roles, identity, scope, time, modality, attribution and polarity. Bound fixpoint expansion; detect cycles. For each consequence record every essential premise ID, exact rule/procedure ID and version, transformation, applicability conditions, assumptions and dependency fingerprint. Search counterevidence before closing a goal.

## Output and stopping
Return supported consequences plus provenance, or residual subgoals with missing evidence. A derived statement is not independent evidence; its entire premise chain must reopen. Do not strengthen an uncertain, possible, attributed or time-bounded premise.
