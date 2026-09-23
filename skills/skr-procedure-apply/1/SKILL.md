# SKR Procedure Apply v1.0

## Inputs
Apply the exact `procedureId` and `procedureVersion` selected by the server to the pinned snapshot and authorized scope. Read parameters from `request.json`; never substitute a newer procedure.

## Method
Follow the procedure steps and evidence obligations. Record the exact version, parameters, source scope, dependencies, output type and support state for every finding. Reopen original regions, include counterevidence and preserve uncertainty. Keep heuristic/reference judgments separate from expert judgments.

## Output
Return procedure-run metadata, `findings`, `evidence`, `coverage`, `changeSet` for staged materialization only, and validation. Each material finding has a dependency list and exact procedure version. Do not publish directly. Stop when the procedure's coverage obligations are met or list residuals when they cannot be met.
