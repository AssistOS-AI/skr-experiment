# SKR Audit Evidence v1.0

## Audit steps
For each claim, resolve all evidence IDs. Reopen source bytes and the pinned source region; verify the quote, stable locator and authorized source version. Check claim strength, attribution, modality, polarity, time, entity identity, units, exceptions and counterevidence. Follow derived premise IDs recursively; reject missing, cyclic, stale or out-of-scope dependencies. Replay explicit pinned rules when the derivation says rule replay.

## Output
Return `status`, `checkedEvidenceIds`, `errors`, `claimCount`, and `unsupportedClaims`, plus concise details for rejected claims. A schema-valid citation is not proof of entailment. Mark semantic interpretation unresolved whenever the evidence only establishes topical relevance or a weaker statement.

## Stop
Reject publication if a supported material claim lacks reopenable evidence or any required derived premise is invalid. Preserve unsupported claims as residuals only when the answer clearly labels them.
