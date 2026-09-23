# SKR Ingest Source v1.0

## Inputs
Use only selected source versions in `request.json` and their pinned source bytes/regions. Preserve originals. Do not access arbitrary paths or unselected sources.

## Stages
Register the exact source version; inventory all regions and reader coverage; mark each as readable, deferred, unreadable or intentionally excluded. Extract only explicit structured facts conservatively. Separate candidate entities/coreference from accepted stable identities. Reconcile candidates against pinned records, then perform a bounded context pass for scope and exceptions. Validate quotes, locators, schema and dependencies before proposing a materialization.

## Output
Return `coverage` ledger entries with source version, region, locator, state and reason; candidate assertions; entity ambiguities; optional staged records; and validation state. Every extracted assertion must quote its exact region and preserve attribution, time, modality and polarity. No semantic extraction may be claimed for deferred regions or when only deterministic parsing was run.
