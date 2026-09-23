# SKR Match v1.0

## Inputs and scope
Use the structured goal, current bindings, pinned snapshot records and authorized scope from `request.json`. Exclude stale, superseded, retracted and out-of-scope records. Preserve source version, region, attribution, time, modality and polarity.

## Matching
Unify predicate names and every argument in position. Keep repeated variables shared across joins. Report one binding row per coherent match. Distinguish equivalent, candidate-entails-goal, goal-entails-candidate, related, incompatible-in-scope, ambiguous and unsupported. A weaker candidate cannot satisfy a stronger goal by itself; never reverse argument roles. Check exceptions and counterevidence before accepting a match.

## Output
For every result include relation/direction, bindings, evidence IDs, argument mapping, scope, assumptions, residual constraints and candidate coverage. Evidence must reopen through exact source IDs and stable region locators. Keep plausible alternatives when identity or scope is ambiguous.
