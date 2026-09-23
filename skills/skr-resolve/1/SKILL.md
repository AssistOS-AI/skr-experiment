# SKR Resolve v1.0

## Inputs
Read `request.json`, the scoped pinned `snapshot.json`, only the authorized `sources/` files, and linked match/reason/audit skills. Input fields: `taskType`, `text`, `sourceScope`, `snapshotId`, optional procedure ID/version/parameters.

## Required method
1. Interpret the request into explicit answer goals and coverage obligations. A structured SKE query is exact; natural language needs explicit interpretation and must retain ambiguity.
2. Search pinned local records, preserve shared-variable bindings and enumerate relevant candidate evidence. Use active procedures only at their pinned versions.
3. Inspect original selected regions for exceptions, time, attribution, modality, polarity and counterevidence. Do not treat lexical similarity as entailment.
4. Audit each material factual claim and every dependency chain. Unsupported and partial claims must be labeled as such.

## Output
Return one JSON bundle with `answerPackage` (`answer`, `claims:[{text,evidenceIds,supportState}]`, `interpretation`, `supportState`, `coverage`, `procedureVersions`, `snapshotId`, `residuals`), `evidence`, `coverage`, optional `changeSet`, and `validation`. Source evidence requires exact `sourceVersionId`, `regionId`, and a quote that reopens in that region. Derived evidence requires all premise IDs and an explicit transformation.

## Stop
Stop with a justified partial/unresolved answer when evidence is missing or conflicting. Never manufacture support or claim a complete answer when required source coverage is deferred.
